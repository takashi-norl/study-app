const DB = 'hibi-demo-files';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request=indexedDB.open(DB,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('files');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export async function saveLocalFile(id:string,file:Blob):Promise<void> {
  const db=await open();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readwrite'); tx.objectStore('files').put(file,id);
    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
export async function loadLocalFile(id:string):Promise<Blob|undefined> {
  const db=await open();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('files').objectStore('files').get(id);
    request.onsuccess=()=>{db.close();resolve(request.result);};
    request.onerror=()=>{db.close();reject(request.error);};
  });
}
export async function clearLocalFiles():Promise<void> {
  const db=await open();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readwrite');tx.objectStore('files').clear();
    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
