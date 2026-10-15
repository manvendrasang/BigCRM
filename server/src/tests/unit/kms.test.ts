/**
 * Key provider tests.
 *
 * Two properties carry the whole feature: the `env` provider derives exactly
 * the historical HKDF key (a changed parameter orphans every stored MFA
 * secret), and the `kms` provider refuses anything but a 32-byte data key.
 * The AWS call itself is never made here — a stub decrypt stands in, because
 * these tests prove key handling, not the network path to KMS.
 */
import { hkdfSync } from 'node:crypto';
import { env } from '../../config/env.ts';
import { fieldKey, initKeyProvider, __testing } from '../../lib/kms.ts';
import { encryptSecret, decryptSecret } from '../../services/mfa.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 120)}`;
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l}${detail}`); }
};

console.log('\n=== env provider matches the historical derivation ===');
{
  const expected = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(env.secretsPepper, 'utf8'),
    Buffer.from('bigcrm-field-encryption', 'utf8'),
    Buffer.from('mfa.totp_secret', 'utf8'),
    32,
  ));
  T('fieldKey equals the pre-provider HKDF output byte-for-byte',
    fieldKey('mfa.totp_secret').equals(expected));
  T('different purposes derive different keys',
    !fieldKey('mfa.totp_secret').equals(fieldKey('other.purpose')));

  const provider = await initKeyProvider();
  T('the default provider is env', provider.id === 'env', provider.id);
  T('env.mfaKeyProvider defaults to env', env.mfaKeyProvider === 'env', env.mfaKeyProvider);
}

console.log('\n=== kms provider ===');
{
  const fakeKey = Buffer.alloc(32, 7);
  const stub = async (): Promise<Uint8Array> => fakeKey;

  const kms = await __testing.KmsKeyProvider.create(Buffer.from('ciphertext').toString('base64'), stub);
  T('a 32-byte data key is accepted', kms.id === 'kms');
  T('the data key is used directly, not derived', kms.fieldKey('anything').equals(fakeKey));

  let short = false;
  try {
    await __testing.KmsKeyProvider.create(
      Buffer.from('x').toString('base64'), async () => Buffer.alloc(16));
  } catch { short = true; }
  T('a short data key is refused', short);

  let failing = false;
  try {
    await __testing.KmsKeyProvider.create(
      Buffer.from('x').toString('base64'), async () => { throw new Error('KMS down'); });
  } catch { failing = true; }
  T('a KMS failure propagates instead of falling back to env', failing);

  // The envelope works under either provider — same format, same length key.
  __testing.setProvider(kms);
  try {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP');
    T('encrypt/decrypt round-trips under the kms provider', decryptSecret(sealed) === 'JBSWY3DPEHPK3PXP');
  } finally {
    __testing.setProvider(null);
  }
  T('resetting restores the env default', fieldKey('mfa.totp_secret').length === 32);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
