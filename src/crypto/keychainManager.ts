import crypto from 'crypto';
import inquirer from 'inquirer';
import keytar from 'keytar';
import { Database } from 'better-sqlite3';

import { DeviceKeys, DeviceKeysWithLogin, Secrets } from '../types.js';
import { registerDevice } from '../middleware/registerDevice.js';
import { encryptAES } from './encrypt.js';
import { decrypt, getDerivateUsingParametersFromEncryptedData } from './decrypt.js';
import { EncryptedData } from './types';
import { sha512 } from './hash.js';

const SERVICE = 'dashlane-cli';

const setLocalKey = async (login: string, localKey?: Buffer): Promise<Buffer> => {
    if (!localKey) {
        localKey = crypto.randomBytes(32);
        if (!localKey) {
            throw new Error('Unable to generate AES local key');
        }
    }

    await keytar.setPassword(SERVICE, login, localKey.toString('base64'));
    return localKey;
};

const getLocalKey = async (login: string): Promise<Buffer | undefined> => {
    const localKeyEncoded = await keytar.getPassword(SERVICE, login);

    if (localKeyEncoded) {
        return Buffer.from(localKeyEncoded, 'base64');
    } else {
        return undefined;
    }
};

/**
 * Fake transaction used to set derivation parameters to encrypt the local key in the DB using the master password
 */
const getDerivationParametersForLocalKey = (login: string): EncryptedData => {
    return {
        keyDerivation: {
            algo: 'argon2d',
            saltLength: 16,
            tCost: 3,
            mCost: 32768,
            parallelism: 2,
        },
        cipherConfig: {
            encryption: 'aes256', // Unused parameter
            cipherMode: 'cbchmac', // Unused parameter
            ivLength: 0, // Unused parameter
        },
        cipherData: {
            salt: sha512(login).slice(0, 16),
            iv: Buffer.from(''), // Unused parameter
            hash: Buffer.from(''), // Unused parameter
            encryptedPayload: Buffer.from(''), // Unused parameter
        },
    };
};

const getSecretsWithoutDB = async (
    db: Database,
    login: string,
    masterPassword?: string,
    localKey?: Buffer
): Promise<Secrets> => {
    if (!masterPassword) {
        masterPassword = await promptMasterPassword();
    }

    const derivate = await getDerivateUsingParametersFromEncryptedData(
        masterPassword,
        getDerivationParametersForLocalKey(login)
    );

    const { deviceAccessKey, deviceSecretKey } = await registerDevice({ login });

    if (!localKey) {
        localKey = await setLocalKey(login);
    }

    const deviceSecretKeyEncrypted = encryptAES(localKey, Buffer.from(deviceSecretKey, 'hex'));
    const masterPasswordEncrypted = encryptAES(localKey, Buffer.from(masterPassword));
    const localKeyEncrypted = encryptAES(derivate, localKey);

    db.prepare('REPLACE INTO device VALUES (?, ?, ?, ?, ?)')
        .bind(login, deviceAccessKey, deviceSecretKeyEncrypted, masterPasswordEncrypted, localKeyEncrypted)
        .run();

    return {
        login,
        masterPassword,
        accessKey: deviceAccessKey,
        secretKey: deviceSecretKey,
    };
};

const getSecretsWithoutKeychain = async (
    login: string,
    deviceKeys: DeviceKeys,
    masterPassword?: string
): Promise<Secrets> => {
    if (!masterPassword) {
        masterPassword = await promptMasterPassword();
    }

    const derivate = await getDerivateUsingParametersFromEncryptedData(
        masterPassword,
        getDerivationParametersForLocalKey(login)
    );

    const localKey = decrypt(deviceKeys.localKeyEncrypted, derivate);
    const secretKey = decrypt(deviceKeys.secretKeyEncrypted, localKey).toString('hex');

    await setLocalKey(login, localKey);

    return {
        login,
        masterPassword,
        accessKey: deviceKeys.accessKey,
        secretKey,
    };
};

export const getSecrets = async (
    db: Database,
    deviceKeys: DeviceKeysWithLogin | null,
    masterPassword?: string
): Promise<Secrets> => {
    let login: string;
    if (deviceKeys) {
        login = deviceKeys.login;
    } else {
        login = (
            await inquirer.prompt<{ login: string }>([
                {
                    type: 'input',
                    name: 'login',
                    message: 'Please enter your email address:',
                },
            ])
        ).login;
    }

    const localKey = await getLocalKey(login);

    // If there are no secrets in the DB
    if (!deviceKeys) {
        return getSecretsWithoutDB(db, login, masterPassword, localKey);
    }

    // If the keychain is unreachable, or empty, the local key is retrieved from the master password from the DB
    if (!localKey) {
        return getSecretsWithoutKeychain(login, deviceKeys, masterPassword);
    }

    // Otherwise, the local key can be used to decrypt the device secret key and the master password in the DB
    if (!masterPassword) {
        masterPassword = decrypt(deviceKeys.masterPasswordEncrypted, localKey).toString();
    }
    const secretKey = decrypt(deviceKeys.secretKeyEncrypted, localKey).toString('hex');

    return {
        login,
        masterPassword,
        accessKey: deviceKeys.accessKey,
        secretKey,
    };
};

export const promptMasterPassword = async (): Promise<string> => {
    return (
        await inquirer.prompt<{ masterPassword: string }>([
            {
                type: 'password',
                name: 'masterPassword',
                message: 'Please enter your master password:',
            },
        ])
    ).masterPassword;
};

export const askReplaceMasterPassword = async () => {
    const promptedReplaceMasterPassword: string = (
        await inquirer.prompt<{ replaceMasterPassword: string }>([
            {
                type: 'list',
                name: 'replaceMasterPassword',
                message: "Couldn't decrypt any password, would you like to retry?",
                choices: ['Yes', 'No'],
            },
        ])
    ).replaceMasterPassword;

    return promptedReplaceMasterPassword === 'Yes';
};
