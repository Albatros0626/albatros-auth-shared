"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BIOMETRIC_KEY_NAME = exports.SUPPORTED_BIOMETRIC_BLOB_VERSIONS = exports.BIOMETRIC_BLOB_VERSION = void 0;
exports.createBiometricService = createBiometricService;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const types_1 = require("./types");
exports.BIOMETRIC_BLOB_VERSION = 1;
exports.SUPPORTED_BIOMETRIC_BLOB_VERSIONS = [1];
exports.DEFAULT_BIOMETRIC_KEY_NAME = 'AlbatrosAuthShared';
const HKDF_DIGEST = 'sha256';
const HKDF_INFO = 'albatros-auth-shared/biometric-kek/v1';
const KEK_LENGTH = 32;
const CHALLENGE_LENGTH = 32;
const HKDF_SALT_LENGTH = 32;
const GCM_IV_LENGTH = 12;
/**
 * Everything stored in cleartext is bound into the GCM tag as additional
 * authenticated data. Without this the tag would only cover the ciphertext,
 * leaving `boundTo` (the staleness guard) and `challenge` forgeable by anyone
 * who can write the file.
 *
 * The field order is part of the format: changing it invalidates every
 * existing blob, so it must move together with `BIOMETRIC_BLOB_VERSION`.
 */
function buildAad(meta) {
    // JSON array serialisation is injective: a plain separator join would turn
    // ambiguous the day a keyName contains the separator character. The field
    // order is part of the format — changing it invalidates every existing
    // blob, so it must move together with BIOMETRIC_BLOB_VERSION.
    return Buffer.from(JSON.stringify([meta.version, meta.keyName, meta.challenge, meta.salt, meta.boundTo, meta.createdAt]), 'utf-8');
}
function deriveKek(signature, salt) {
    return Buffer.from((0, crypto_1.hkdfSync)(HKDF_DIGEST, signature, salt, HKDF_INFO, KEK_LENGTH));
}
function buffersEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(a, b);
}
/**
 * The provider reports why Hello refused; anything else is `unknown`.
 * Driven by BIOMETRIC_REJECTION_REASONS so the literal list lives in exactly
 * one place — a reason added to the union cannot be silently collapsed here.
 */
function extractReason(err) {
    const r = err?.reason;
    if (typeof r === 'string' && types_1.BIOMETRIC_REJECTION_REASONS.includes(r)) {
        return r;
    }
    return 'unknown';
}
function isCompleteBlob(o) {
    return (typeof o.keyName === 'string' &&
        typeof o.challenge === 'string' &&
        typeof o.salt === 'string' &&
        typeof o.iv === 'string' &&
        typeof o.ciphertext === 'string' &&
        typeof o.authTag === 'string' &&
        typeof o.boundTo === 'string' &&
        typeof o.createdAt === 'string');
}
function createBiometricService(opts) {
    const { blobPath, authService } = opts;
    const provider = opts.provider ?? null;
    const keyName = opts.keyName ?? exports.DEFAULT_BIOMETRIC_KEY_NAME;
    function readBlob() {
        if (!(0, fs_1.existsSync)(blobPath))
            return { kind: 'absent' };
        let parsed;
        try {
            parsed = JSON.parse((0, fs_1.readFileSync)(blobPath, 'utf-8'));
        }
        catch {
            return { kind: 'corrupt' };
        }
        if (typeof parsed.version !== 'number')
            return { kind: 'corrupt' };
        if (parsed.version > exports.BIOMETRIC_BLOB_VERSION) {
            // Newer format: another app on this machine runs a more recent build.
            // Treat as "no enrolment here" but never delete it — that would silently
            // revoke the user's enrolment just by launching an older app.
            return { kind: 'future', version: parsed.version };
        }
        if (!exports.SUPPORTED_BIOMETRIC_BLOB_VERSIONS.includes(parsed.version)) {
            // Unsupported but NOT newer (e.g. version 0): junk, safe to discard.
            // Without this distinction it would be preserved forever under a false
            // "written by a newer app" log line.
            return { kind: 'corrupt' };
        }
        if (!isCompleteBlob(parsed))
            return { kind: 'corrupt' };
        return { kind: 'ok', blob: parsed };
    }
    function writeBlob(blob) {
        // Per-writer tmp suffix, same rationale as secrets-service/session-service:
        // two Albatros apps can enrol or revoke concurrently.
        const tmp = `${blobPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
            (0, fs_1.writeFileSync)(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
            try {
                (0, fs_1.chmodSync)(tmp, 0o600);
            }
            catch { /* best effort on non-POSIX */ }
            (0, fs_1.renameSync)(tmp, blobPath);
        }
        catch (err) {
            try {
                if ((0, fs_1.existsSync)(tmp))
                    (0, fs_1.unlinkSync)(tmp);
            }
            catch { /* ignore */ }
            throw err;
        }
    }
    function destroyBlob(why) {
        try {
            if ((0, fs_1.existsSync)(blobPath))
                (0, fs_1.unlinkSync)(blobPath);
            // eslint-disable-next-line no-console
            console.error(`[biometric] enrolment discarded: ${why}`);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[biometric] failed to remove blob:', err);
        }
    }
    async function deleteKeyQuietly(name = keyName) {
        if (!provider)
            return;
        try {
            await provider.deleteKey(name);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[biometric] failed to remove Hello key:', err);
        }
    }
    async function doUnlock(hwnd) {
        if (!provider)
            return { ok: false, failure: 'not-enrolled' };
        const read = readBlob();
        if (read.kind === 'absent')
            return { ok: false, failure: 'not-enrolled' };
        if (read.kind === 'future') {
            // eslint-disable-next-line no-console
            console.error(`[biometric] blob version ${read.version} written by a newer app; ignoring (not deleting)`);
            return { ok: false, failure: 'not-enrolled' };
        }
        if (read.kind === 'corrupt') {
            destroyBlob('unreadable blob');
            return { ok: false, failure: 'not-enrolled' };
        }
        const blob = read.blob;
        // Staleness check BEFORE prompting: a blob bound to a superseded code would
        // hand verifyCode() the wrong value and burn a lockout attempt per unlock.
        const boundToAtStart = authService.getLastCodeChangeDate();
        if (blob.boundTo !== boundToAtStart) {
            destroyBlob('code changed since enrolment');
            return { ok: false, failure: 'stale' };
        }
        // Don't make the user present a finger for a refusal we already know
        // about. Only `locked_until` matters here: `required_delay_seconds`
        // throttles WRONG guesses in the UI, and the code this path restores is
        // either correct (counter resets) or stale (caught before verifyCode) —
        // reviewed and deliberately not enforced.
        const lockout = authService.getLockoutStatus();
        if (lockout.locked_until) {
            return { ok: false, failure: 'code-refused', lockoutStatus: lockout };
        }
        let signature;
        try {
            // Sign with the key recorded IN the blob, not the service-configured
            // name: two apps sharing a blobPath but configured with different
            // keyNames would otherwise sign with the wrong key, fail the GCM check
            // and destroy each other's valid enrolment. blob.keyName is
            // AAD-authenticated, so it cannot be redirected undetected.
            signature = await provider.sign(blob.keyName, Buffer.from(blob.challenge, 'base64'), hwnd);
        }
        catch (err) {
            const reason = extractReason(err);
            if (reason === 'not-found') {
                // The key pair is permanently gone (NGC/TPM reset, Hello
                // re-provisioned). Keep the README's promise: discard the enrolment
                // so the button vanishes on its own instead of failing forever.
                destroyBlob('Hello key no longer exists');
                return { ok: false, failure: 'key-mismatch', reason };
            }
            // Transient (cancelled, sensor busy, Hello locked): keep the enrolment.
            return { ok: false, failure: 'rejected', reason };
        }
        let code;
        try {
            const kek = deriveKek(signature, Buffer.from(blob.salt, 'base64'));
            const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', kek, Buffer.from(blob.iv, 'base64'));
            decipher.setAAD(buildAad(blob));
            decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
            code = Buffer.concat([
                decipher.update(Buffer.from(blob.ciphertext, 'base64')),
                decipher.final(),
            ]).toString('utf-8');
        }
        catch {
            // Wrong signature (key replaced/lost) or tampered metadata. Critically,
            // verifyCode() is NOT called here — a garbled code would consume a
            // lockout attempt for what is not a failed authentication.
            destroyBlob('Hello key mismatch or tampered blob');
            return { ok: false, failure: 'key-mismatch' };
        }
        // The Hello prompt takes seconds; another app may have changed the code in
        // the meantime, which would make the restored code wrong and cost an
        // attempt. Re-check before spending one.
        if (authService.getLastCodeChangeDate() !== boundToAtStart) {
            destroyBlob('code changed while the Hello prompt was open');
            return { ok: false, failure: 'stale' };
        }
        const ok = await authService.verifyCode(code);
        if (!ok) {
            return { ok: false, failure: 'code-refused', lockoutStatus: authService.getLockoutStatus() };
        }
        return { ok: true };
    }
    let inFlight = null;
    return {
        async isSupported() {
            if (!provider)
                return false;
            try {
                return await provider.isAvailable();
            }
            catch {
                return false;
            }
        },
        isEnrolled() {
            if (!provider)
                return false;
            return readBlob().kind === 'ok';
        },
        async enroll(code, hwnd) {
            if (!provider)
                throw new types_1.BiometricUnavailableError();
            let available;
            try {
                available = await provider.isAvailable();
            }
            catch {
                available = false;
            }
            if (!available)
                throw new types_1.BiometricUnavailableError();
            // Same guard as recover(): no code-testing during an active lockout.
            // verifyCurrentCode counts nothing, so without this check enroll()
            // would be a lockout-free brute-force oracle at PBKDF2 speed.
            if (authService.getLockoutStatus().locked_until) {
                throw new Error('Application verrouillée, réessayez plus tard');
            }
            // Snapshot BEFORE the ~300ms verifyCurrentCode: a concurrent
            // changeCode() mid-verification would otherwise seal the OLD code under
            // the NEW change date — a blob that passes every staleness guard and
            // burns a lockout attempt per unlock.
            const boundTo = authService.getLastCodeChangeDate();
            if (!boundTo)
                throw new types_1.VaultNotInitializedError();
            // verifyCurrentCode, not verifyCode: enrolling must not touch
            // failed_attempts or the lockout window.
            if (!(await authService.verifyCurrentCode(code))) {
                throw new types_1.BiometricCodeRejectedError();
            }
            // The code was right for the vault we snapshotted; if the date moved
            // during verification, the code we hold is already superseded.
            if (authService.getLastCodeChangeDate() !== boundTo) {
                throw new types_1.BiometricCodeRejectedError();
            }
            await provider.createKey(keyName, hwnd);
            try {
                // Only NOW is the previous enrolment dead — createKey just replaced
                // its key pair. Destroying it any earlier would lose a still-valid
                // enrolment if the user cancelled the createKey prompt.
                if ((0, fs_1.existsSync)(blobPath))
                    destroyBlob('re-enrolment');
                const challenge = (0, crypto_1.randomBytes)(CHALLENGE_LENGTH);
                const signature = await provider.sign(keyName, challenge, hwnd);
                // Determinism was measured on one machine; another TPM could sign with
                // a randomised scheme and produce a blob that never decrypts. Verify it
                // here instead of trusting it. Cheap: Windows caches the biometric
                // ticket right after a verification (measured 289ms, no second prompt).
                const confirmation = await provider.sign(keyName, challenge, hwnd);
                if (!buffersEqual(signature, confirmation)) {
                    throw new types_1.BiometricNonDeterministicError();
                }
                const salt = (0, crypto_1.randomBytes)(HKDF_SALT_LENGTH);
                const iv = (0, crypto_1.randomBytes)(GCM_IV_LENGTH);
                const meta = {
                    version: exports.BIOMETRIC_BLOB_VERSION,
                    keyName,
                    challenge: challenge.toString('base64'),
                    salt: salt.toString('base64'),
                    boundTo,
                    createdAt: new Date().toISOString(),
                };
                const cipher = (0, crypto_1.createCipheriv)('aes-256-gcm', deriveKek(signature, salt), iv);
                cipher.setAAD(buildAad(meta));
                const ciphertext = Buffer.concat([cipher.update(code, 'utf-8'), cipher.final()]);
                // Final freshness check after several seconds of Hello prompts — the
                // same TOCTOU family as the recheck in unlock(). A code changed by
                // another app while the prompts were open must not get sealed.
                if (authService.getLastCodeChangeDate() !== boundTo) {
                    throw new types_1.BiometricCodeRejectedError();
                }
                writeBlob({
                    ...meta,
                    iv: iv.toString('base64'),
                    ciphertext: ciphertext.toString('base64'),
                    authTag: cipher.getAuthTag().toString('base64'),
                });
            }
            catch (err) {
                // All-or-nothing: never leave an orphan Hello key on the user's profile.
                await deleteKeyQuietly();
                throw err;
            }
        },
        unlock(hwnd) {
            // Serialise in the service, not just the UI: a double-click would
            // otherwise race two Hello prompts against each other.
            if (inFlight)
                return inFlight;
            inFlight = doUnlock(hwnd).finally(() => {
                inFlight = null;
            });
            return inFlight;
        },
        async disable() {
            // Delete the key the blob actually records, falling back to the
            // configured name — otherwise a divergent configuration would remove
            // the wrong key and leave the real one orphaned on the profile.
            const read = readBlob();
            const nameToDelete = read.kind === 'ok' ? read.blob.keyName : keyName;
            destroyBlob('disabled by user');
            await deleteKeyQuietly(nameToDelete);
        },
    };
}
//# sourceMappingURL=biometric-service.js.map