import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';

const identity = process.env.MAC_SIGNING_IDENTITY;
const outputs = await packager({
  dir: '.', name: 'Live Translator', out: 'dist', overwrite: true,
  icon: 'assets/icon.icns',
  appBundleId: 'com.electron.live-translator',
  ignore: /^\/(test|dist|scripts)($|\/)/,
  ...(process.platform === 'darwin' ? {
    osxSign: {
      identity: identity || '-',
      identityValidation: Boolean(identity),
      optionsForFile: () => ({ hardenedRuntime: Boolean(identity) }),
    },
  } : {}),
});
for (const output of outputs) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', `${output}/Live Translator.app`], { stdio: 'inherit' });
  }
  console.log(output);
}
if (process.platform === 'darwin' && !identity) {
  console.warn('Ad-hoc signed build: integrity verified, but NOT Developer ID signed or notarized. Gatekeeper will still require user approval.');
}
