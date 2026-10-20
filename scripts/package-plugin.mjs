import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { writeZip } from './lib/zip.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin/manifest.json'),'utf8'));
const output=path.join(root,'artifacts','release');await fs.mkdir(output,{recursive:true});
const entries=[];
for(const name of ['main.js','manifest.json','styles.css']){
  const data=await fs.readFile(path.join(root,'plugin',name));await fs.writeFile(path.join(output,name),data);entries.push({name:`nine-sync/${name}`,data});
}
const zip=`9sync-plugin-${manifest.version}.zip`;await writeZip(path.join(output,zip),entries);
const checksums=[];for(const name of ['main.js','manifest.json','styles.css',zip])checksums.push(`${crypto.createHash('sha256').update(await fs.readFile(path.join(output,name))).digest('hex')}  ${name}`);
await fs.writeFile(path.join(output,'SHA256SUMS'),checksums.join('\n')+'\n');
console.log(`Plugin release: ${path.join(output,zip)}`);
