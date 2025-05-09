import * as bip39 from "bip39";
import { BIP32Factory, BIP32Interface } from "bip32";
import * as bitcoin from "bitcoinjs-lib";
import * as crypto from "crypto";
import { ecc } from "@/lib/crypto/ecc.js";
import { NETWORK } from "@/lib/consts";
import { ECPairFactory } from "ecpair";
import { EsploraUtxo } from "@/lib/apis/esplora/types.js";
import { BoxedResponse, BoxedError, BoxedSuccess } from "../utils/boxed.js";
import { tweakKey } from "bitcoinjs-lib/src/payments/bip341"; // ⚠ internal
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { get } from "http";
export const bip32 = BIP32Factory(ecc);
export const ECPair = ECPairFactory(ecc);

bitcoin.initEccLib?.(ecc);

const PATH = "m/86'/0'/0'"; // BIP86

//GLOBAL TYPES
export type WalletSigner = {
  root: BIP32Interface;
  xprv: BIP32Interface;
  xpub: BIP32Interface;
  seed: Buffer;
};

export type DecryptedWallet = {
  mnemonic: string;
  signer: WalletSigner;
};

export type EncryptedMnemonic = {
  kdf: string;
  cipher: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

export function getSigner(mnemonic: string): WalletSigner {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);

  if (!root) {
    throw new Error("Failed to create root key from seed");
  }

  const xprv = root.derivePath(PATH);
  const xpub = xprv.neutered();

  return { xprv, xpub, seed, root };
}

export function toTaprootSigner(signer: WalletSigner) {
  const { root: rootKey } = signer;

  const childNode = rootKey.derivePath(PATH);
  const childNodeXOnlyPubkey = toXOnly(Buffer.from(childNode.publicKey));

  const tweakedChildNode = childNode.tweak(
    bitcoin.crypto.taggedHash("TapTweak", childNodeXOnlyPubkey)
  );

  return {
    ...tweakedChildNode,
    publicKey: Buffer.from(tweakedChildNode.publicKey),
    sign: (message: Buffer) =>
      Buffer.from(tweakedChildNode.sign(Buffer.from(message))),
    signSchnorr: (message: Buffer) =>
      Buffer.from(tweakedChildNode.signSchnorr(Buffer.from(message))),
  } as bitcoin.Signer;
}

export function getWitnessUtxo(utxo: EsploraUtxo, signer: WalletSigner) {
  const { root: rootKey } = signer;

  const childNode = rootKey.derivePath(PATH);

  const childNodeXOnlyPubkey = toXOnly(Buffer.from(childNode.publicKey));

  const { address, output, signature } = bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(childNodeXOnlyPubkey),
    network: NETWORK,
  });

  if (!output) {
    throw new Error("Failed to derive p2tr output script");
  }

  return {
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: output,
      value: utxo.value,
    },
    tapInternalKey: Buffer.from(childNodeXOnlyPubkey),
  };
}

export function firstTaprootAddress(signer: WalletSigner): string {
  const rootKey = signer.root;

  const childNode = rootKey.derivePath(PATH);

  const childNodeXOnlyPubkey = toXOnly(Buffer.from(childNode.publicKey));

  const { address } = bitcoin.payments.p2tr({
    internalPubkey: childNodeXOnlyPubkey,
    network: NETWORK,
  });
  if (!address) throw new Error("failed to derive p2tr address");
  return address;
}

// ––––– helper: simple AES‑256‑GCM encryption ––––– //
export function encryptMnemonic(
  mnemonic: string,
  password: string
): EncryptedMnemonic {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32); // KDF
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(mnemonic, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: ciphertext.toString("hex"),
  };
}

export function decryptWalletWithPassword(
  encrypted: EncryptedMnemonic,
  password: string
): DecryptedWallet {
  const salt = Buffer.from(encrypted.salt, "hex");
  const key = crypto.scryptSync(password, salt, 32);
  const iv = Buffer.from(encrypted.iv, "hex");
  const tag = Buffer.from(encrypted.tag, "hex");
  const data = Buffer.from(encrypted.data, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return {
    mnemonic: decrypted.toString("utf8"),
    signer: getSigner(decrypted.toString("utf8")),
  };
}

export type SavedWallet = {
  encryptedMnemonic: EncryptedMnemonic;
  address: string;
};

export async function isValidMnemonic(mnemonic: string): Promise<boolean> {
  try {
    const isValid = await bip39.validateMnemonic(mnemonic);
    return isValid;
  } catch (err: unknown) {
    return false;
  }
}
export async function generateWallet(opts: {
  from_mnemonic?: string;
  password: string;
}): Promise<
  BoxedResponse<DecryptedWallet & { walletJson: SavedWallet }, WalletError>
> {
  const mnemonic = opts.from_mnemonic ?? bip39.generateMnemonic(128);
  try {
    const signer = getSigner(mnemonic);
    return new BoxedSuccess({
      mnemonic,
      signer: signer,
      walletJson: {
        encryptedMnemonic: encryptMnemonic(mnemonic, opts.password),
        address: firstTaprootAddress(signer),
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      return new BoxedError(WalletError.InvalidMnemonic, err.message);
    } else {
      return new BoxedError(WalletError.InvalidMnemonic, "Invalid mnemonic");
    }
  }
}

enum WalletError {
  InvalidMnemonic = "InvalidMnemonic",
}
