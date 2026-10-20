// Small dependency-free ZIP writer (stored entries, UTF-8). Release files are
// already small; no external zip, Python, or platform-specific archiver needed.
import fs from 'node:fs/promises';
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=table[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
export async function writeZip(destination,entries){
  const chunks=[],central=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name.replaceAll('\\','/'),'utf8'),data=entry.data ?? await fs.readFile(entry.path),crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
    chunks.push(header,name,data);
    const item=Buffer.alloc(46);item.writeUInt32LE(0x02014b50,0);item.writeUInt16LE(20,4);item.writeUInt16LE(20,6);item.writeUInt16LE(0x800,8);item.writeUInt16LE(0x21,14);item.writeUInt32LE(crc,16);item.writeUInt32LE(data.length,20);item.writeUInt32LE(data.length,24);item.writeUInt16LE(name.length,28);item.writeUInt32LE(offset,42);central.push(item,name);
    offset+=header.length+name.length+data.length;
  }
  const centralSize=central.reduce((sum,b)=>sum+b.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
  await fs.writeFile(destination,Buffer.concat([...chunks,...central,end]));
}
