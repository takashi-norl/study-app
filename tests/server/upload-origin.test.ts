import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { createSourceUpload } from '../../src/server/google-store';

test('Drive resumable initiation binds final upload CORS to the validated browser origin', async()=>{
  const values={
    NEXTAUTH_SECRET:'test-only-secret-with-at-least-32-characters',
    GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET:'test-only-client-secret',
    GOOGLE_DRIVE_REFRESH_TOKEN:'test-only-refresh-token',
    GOOGLE_DRIVE_FOLDER_ID:'test-folder-12345678',
    GOOGLE_SHEETS_ID:'test-sheet-12345678',
    GOOGLE_DRIVE_OWNER_EMAIL:'owner@example.com',
  };
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);
  const access=mock.method(OAuth2Client.prototype,'getAccessToken',async()=>({token:'test-only-access-token'}));
  const info=mock.method(OAuth2Client.prototype,'getTokenInfo',async()=>({
    aud:values.GOOGLE_CLIENT_ID,scopes:['https://www.googleapis.com/auth/drive.file'],
    email:values.GOOGLE_DRIVE_OWNER_EMAIL,email_verified:true,expiry_date:Date.now()+60000,
  }));
  const origin='https://study.example';
  let initiationSeen=false;
  const fetchMock=mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const address=String(url);
    if(address.includes('/files/generateIds?')) return Response.json({ids:['test-file-12345678']});
    assert.equal(address,'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size');
    assert.equal(init?.method,'POST');
    const headers=new Headers(init?.headers);
    assert.equal(headers.get('origin'),origin);
    assert.equal(headers.get('x-upload-content-type'),'image/jpeg');
    assert.equal(headers.get('x-upload-content-length'),'100');
    assert.equal(headers.get('authorization'),'Bearer test-only-access-token');
    const metadata=JSON.parse(String(init?.body));
    assert.deepEqual(metadata.parents,[values.GOOGLE_DRIVE_FOLDER_ID]);
    assert.equal(metadata.appProperties.sourceId,'test-source');
    assert.equal(metadata.appProperties.ownerId,'test-parent');
    assert.equal('topicId' in metadata.appProperties,false);
    initiationSeen=true;
    return new Response(null,{status:200,headers:{location:'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test-only-session'}});
  });
  try {
    const result=await createSourceUpload({sourceId:'test-source',ownerId:'test-parent',name:'photo.jpg',mimeType:'image/jpeg',size:100},origin);
    assert.equal(initiationSeen,true);
    assert.equal(result.fileId,'test-file-12345678');
    assert.equal(JSON.stringify(result).includes('test-only-access-token'),false);
  } finally {
    fetchMock.mock.restore();info.mock.restore();access.mock.restore();
    for(const key of Object.keys(values)) {
      if(old[key]===undefined) delete process.env[key];else process.env[key]=old[key];
    }
  }
});
