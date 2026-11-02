/** Limit a complete SSE frame before the EventSource parser buffers it. Supports all SSE line endings. */
export function boundEventStream(body:ReadableStream<Uint8Array>,limit:number){
 let bytes=0,lineBytes=0,afterCR=false;
 function newline(){if(lineBytes===0)bytes=0;lineBytes=0;}
 return body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,c){
  for(const byte of chunk){
   bytes++;if(bytes>limit)throw Error('Stream frame too large');
   if(byte===10&&afterCR){afterCR=false;continue;}
   afterCR=false;
   if(byte===13){newline();afterCR=true;}else if(byte===10)newline();else lineBytes++;
  }
  c.enqueue(chunk);
 }}));
}
