import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').replace(/^export (?=(?:const|function|async function)\b)/gm, '');
if (/^\s*(?:import|export)\s/m.test(source)) throw new Error('Client must be self-contained.');
const output = `// Generated from src/client.js.\nwindow.__ModuleLoader__.load({\n  id: 'dsh-rider-bridge',\n  factory() {\n${source}\n    return createBridgeClient();\n  },\n});\n`;
writeFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), output, 'utf8');
console.log('Built DSH Rider bridge client.');
