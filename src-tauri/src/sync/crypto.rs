//! End-to-end encryption for sync. The server stores only what this produces:
//! opaque ids and ciphertext. Nothing readable about your writing (text, file
//! names, folder structure) leaves the computer unencrypted.

use aes_gcm::aead::{rand_core::RngCore, Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The secret shared by every computer in a vault. Kept in the OS secret store.
pub struct VaultKey {
    raw: [u8; 32],
    enc: Aes256Gcm,
    file_ids: [u8; 32],
    blob_ids: [u8; 32],
    nonces: [u8; 32],
}

fn subkey(raw: &[u8; 32], label: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"joyce-sync-v1"), raw)
        .expand(label.as_bytes(), &mut out)
        .expect("32 bytes is a valid HKDF length");
    out
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

impl VaultKey {
    pub fn generate() -> Self {
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        Self::from_bytes(raw)
    }

    pub fn from_bytes(raw: [u8; 32]) -> Self {
        let enc_key = subkey(&raw, "content");
        Self {
            raw,
            enc: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&enc_key)),
            file_ids: subkey(&raw, "file-id"),
            blob_ids: subkey(&raw, "blob-id"),
            nonces: subkey(&raw, "nonce"),
        }
    }

    pub fn to_base64(&self) -> String {
        B64.encode(self.raw)
    }

    pub fn from_base64(s: &str) -> Result<Self, String> {
        let bytes = B64.decode(s).map_err(|e| e.to_string())?;
        let raw: [u8; 32] = bytes.try_into().map_err(|_| "Vault key has the wrong length".to_string())?;
        Ok(Self::from_bytes(raw))
    }

    /// Opaque, stable id for a file path. The server can't reverse it or test guesses.
    pub fn file_id(&self, path: &str) -> String {
        hex::encode(hmac(&self.file_ids, path.as_bytes()))
    }

    /// Opaque id for some content; equal content gets the same id, so it's stored once.
    pub fn blob_id(&self, plaintext: &[u8]) -> String {
        hex::encode(hmac(&self.blob_ids, plaintext))
    }

    /// Encrypts file contents. Deterministic (the nonce comes from a keyed hash of
    /// the content), so two computers uploading the same text produce identical
    /// chunks and can never interleave mismatched halves.
    pub fn seal_content(&self, plaintext: &[u8]) -> Vec<u8> {
        let n = hmac(&self.nonces, plaintext);
        self.seal_with(&n[..12], plaintext)
    }

    /// Encrypts small metadata with a random nonce.
    pub fn seal_meta(&self, plaintext: &[u8]) -> String {
        let mut n = [0u8; 12];
        OsRng.fill_bytes(&mut n);
        B64.encode(self.seal_with(&n, plaintext))
    }

    pub fn open_meta(&self, sealed: &str) -> Result<Vec<u8>, String> {
        self.open(&B64.decode(sealed).map_err(|e| e.to_string())?)
    }

    fn seal_with(&self, nonce: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let ct = self.enc.encrypt(Nonce::from_slice(nonce), plaintext).expect("AES-GCM encryption can't fail");
        [nonce, &ct].concat()
    }

    /// Decrypts and authenticates; tampered or foreign data is rejected.
    pub fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < 12 + 16 {
            return Err("Encrypted data is too short".into());
        }
        let (nonce, ct) = sealed.split_at(12);
        self.enc
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| "Couldn't decrypt: wrong key or damaged data".into())
    }
}

// --- Pairing codes ------------------------------------------------------------

/// Letters and digits that can't be confused for one another when read aloud or typed.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 12; // ~59 bits

/// A fresh code like `K7Q2-9XMB-4TRW`.
pub fn new_pairing_code() -> String {
    let mut bytes = [0u8; CODE_LEN];
    OsRng.fill_bytes(&mut bytes);
    // Rejection-free mapping has a slight bias; at 59 bits it doesn't matter.
    let chars: String = bytes.iter().map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char).collect();
    format!("{}-{}-{}", &chars[0..4], &chars[4..8], &chars[8..12])
}

/// Accepts what people actually type: any case, spaces or dashes, and the
/// usual look-alikes (O for 0, I/L for 1).
pub fn normalize_code(code: &str) -> Result<String, String> {
    let cleaned: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect();
    if cleaned.len() != CODE_LEN || !cleaned.bytes().all(|b| CODE_ALPHABET.contains(&b)) {
        return Err("That doesn't look like a pairing code. It's 12 letters and numbers, like K7Q2-9XMB-4TRW.".into());
    }
    Ok(cleaned)
}

/// Turns a pairing code into (a lookup id the server indexes the sealed key by,
/// a key to seal the vault key with). Deliberately slow, so guessing codes against
/// the server or a stolen sealed key is impractical; the code itself never leaves
/// the computer.
pub fn pairing_keys(code: &str) -> Result<(String, Aes256Gcm), String> {
    let normalized = normalize_code(code)?;
    let params = scrypt::Params::new(15, 8, 1, 64).map_err(|e| e.to_string())?;
    let mut out = [0u8; 64];
    scrypt::scrypt(normalized.as_bytes(), b"joyce-pairing-v1", &params, &mut out).map_err(|e| e.to_string())?;
    let lookup = hex::encode(&out[..32]);
    let key = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&out[32..]));
    Ok((lookup, key))
}

pub fn seal_for_pairing(key: &Aes256Gcm, vault: &VaultKey) -> String {
    let mut n = [0u8; 12];
    OsRng.fill_bytes(&mut n);
    let ct = key.encrypt(Nonce::from_slice(&n), vault.raw.as_slice()).expect("encryption can't fail");
    B64.encode([&n[..], &ct].concat())
}

pub fn open_from_pairing(key: &Aes256Gcm, sealed: &str) -> Result<VaultKey, String> {
    let data = B64.decode(sealed).map_err(|e| e.to_string())?;
    if data.len() < 12 {
        return Err("Damaged pairing data".into());
    }
    let (n, ct) = data.split_at(12);
    let raw = key.decrypt(Nonce::from_slice(n), ct).map_err(|_| "That pairing code didn't unlock the vault".to_string())?;
    let raw: [u8; 32] = raw.try_into().map_err(|_| "Damaged pairing data".to_string())?;
    Ok(VaultKey::from_bytes(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_round_trip_and_determinism() {
        let k = VaultKey::generate();
        let a = k.seal_content(b"Stately, plump Buck Mulligan");
        assert_eq!(a, k.seal_content(b"Stately, plump Buck Mulligan"), "same text, same ciphertext");
        assert_ne!(a, k.seal_content(b"Stately, plump Buck Mulligan!"));
        assert_eq!(k.open(&a).unwrap(), b"Stately, plump Buck Mulligan");
        let mut tampered = a.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(k.open(&tampered).is_err(), "tampering is detected");
        assert!(VaultKey::generate().open(&a).is_err(), "another vault can't read it");
    }

    #[test]
    fn ids_are_stable_and_keyed() {
        let k = VaultKey::generate();
        assert_eq!(k.file_id("Novel/One.md"), k.file_id("Novel/One.md"));
        assert_ne!(k.file_id("Novel/One.md"), VaultKey::generate().file_id("Novel/One.md"));
        assert_eq!(k.blob_id(b"x").len(), 64);
        let again = VaultKey::from_base64(&k.to_base64()).unwrap();
        assert_eq!(again.blob_id(b"x"), k.blob_id(b"x"));
    }

    #[test]
    fn pairing_codes() {
        let code = new_pairing_code();
        assert_eq!(code.len(), 14);
        let vault = VaultKey::generate();
        let (lookup, key) = pairing_keys(&code).unwrap();
        let sealed = seal_for_pairing(&key, &vault);
        // Typed sloppily on the other computer: lower case, spaces, no dashes.
        let typed = code.to_lowercase().replace('-', " ");
        let (lookup2, key2) = pairing_keys(&typed).unwrap();
        assert_eq!(lookup, lookup2);
        assert_eq!(open_from_pairing(&key2, &sealed).unwrap().to_base64(), vault.to_base64());
        let (_, wrong) = pairing_keys(&new_pairing_code()).unwrap();
        assert!(open_from_pairing(&wrong, &sealed).is_err());
        assert!(normalize_code("too-short").is_err());
    }
}
