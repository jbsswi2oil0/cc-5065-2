import { runValidation, validateBrightness } from '../src/core/validation.js';

const numeric = runValidation();
const brightness = validateBrightness();
const report = { ...numeric, brightness };
report.ok = numeric.ok && brightness.every((c) => c.pass);

for (const c of report.checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (c.name.startsWith('MIS')) {
    console.log(`      checked=${c.checked} maxSumError=${c.maxSumError.toExponential(3)} zeroActualWeight=${c.zeroActualWeight}`);
  }
  if (c.name.startsWith('forward/reverse')) {
    console.log(`      vertices=${c.vertices} bad=${c.bad} maxReciprocityError=${c.maxReciprocityError}`);
  }
}
for (const c of brightness) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  bdpt=${c.bdpt.toFixed(6)} pt=${c.pt.toFixed(6)} ratio=${c.ratio.toFixed(3)}`);
}

if (!report.ok) process.exitCode = 1;
