export function lineDiff(before: string, after: string) {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) || [];
  const b = after.match(/[^\n]*\n|[^\n]+$/g) || [];
  const lines: { type: 'same' | 'removed' | 'added'; text: string }[] = [];
  let start=0, endA=a.length, endB=b.length;
  while (start<endA && start<endB && a[start]===b[start]) { lines.push({type:'same',text:a[start]}); start++; }
  while (endA>start && endB>start && a[endA-1]===b[endB-1]) { endA--;endB--; }
  const n=endA-start,m=endB-start;
  const simplified=(n+1)*(m+1)>400000;
  if (simplified) {
    for(let i=start;i<endA;i++)lines.push({type:'removed',text:a[i]});
    for(let j=start;j<endB;j++)lines.push({type:'added',text:b[j]});
  } else {
    const width=m+1, matrix=new Uint32Array((n+1)*width);
    for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)matrix[i*width+j]=a[start+i]===b[start+j]?matrix[(i+1)*width+j+1]+1:Math.max(matrix[(i+1)*width+j],matrix[i*width+j+1]);
    let i=0,j=0;
    while(i<n || j<m) {
      if(i<n && j<m && a[start+i]===b[start+j]) { lines.push({type:'same',text:a[start+i]});i++;j++; }
      else if(i<n && (j===m || matrix[(i+1)*width+j]>=matrix[i*width+j+1])) { lines.push({type:'removed',text:a[start+i]});i++; }
      else { lines.push({type:'added',text:b[start+j]});j++; }
    }
  }
  for(let i=endA;i<a.length;i++)lines.push({type:'same',text:a[i]});
  const added=lines.filter(l=>l.type==='added').length, removed=lines.filter(l=>l.type==='removed').length;
  // Keep surrounding context while avoiding a huge DOM for long documents.
  const visible=new Set<number>();
  lines.forEach((line,i)=>{if(line.type!=='same')for(let j=Math.max(0,i-3);j<=Math.min(lines.length-1,i+3);j++)visible.add(j);});
  if(!visible.size)for(let i=0;i<Math.min(20,lines.length);i++)visible.add(i);
  const output: {type:string;text:string}[]=[];let previous=-1;
  for(const i of [...visible].sort((x,y)=>x-y).slice(0,2000)) { if(i>previous+1)output.push({type:'skip',text:`… ${i-previous-1} unchanged lines …\n`});output.push(lines[i]);previous=i; }
  const truncated=visible.size>2000;
  if(truncated)output.push({type:'skip',text:'… preview limited to 2,000 lines; download the full version …\n'});
  else if(previous<lines.length-1)output.push({type:'skip',text:`… ${lines.length-previous-1} unchanged lines …\n`});
  return { lines:output,added,removed,simplified,truncated };
}
