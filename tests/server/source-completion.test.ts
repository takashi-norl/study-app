import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompletedSourceMetadata,type SourceMetadata } from '../../src/server/source-validation';
import { MAX_SOURCE_BYTES } from '../../src/server/config';

const expected={sourceId:'source-id',topicId:'topic-id',storagePath:'drive-file-id',folderId:'private-folder'};
const valid:SourceMetadata={id:'drive-file-id',name:'教材.jpg',mimeType:'image/jpeg',size:'1024',parents:['private-folder'],appProperties:{purpose:'hibi-study-source',sourceId:'source-id',topicId:'topic-id'}};

test('completed source must match upload file, topic, source identity and private app folder',()=>{
  assert.doesNotThrow(()=>assertCompletedSourceMetadata(valid,expected));
  for(const invalid of [
    {...valid,id:'other-file'},
    {...valid,parents:['another-folder']},
    {...valid,appProperties:{...valid.appProperties,purpose:'another-app'}},
    {...valid,appProperties:{...valid.appProperties,sourceId:'another-source'}},
    {...valid,appProperties:{...valid.appProperties,topicId:'another-topic'}},
    {...valid,appProperties:undefined},
  ]) assert.throws(()=>assertCompletedSourceMetadata(invalid,expected),{code:'SOURCE_BINDING_MISMATCH'});
});

test('incomplete, unsupported or oversized uploads never become registered study sources',()=>{
  for(const invalid of [
    {...valid,size:undefined}, {...valid,size:'0'}, {...valid,size:'-1'}, {...valid,size:'0.5'},
    {...valid,size:'NaN'}, {...valid,size:String(MAX_SOURCE_BYTES+1)},
    {...valid,mimeType:'text/html'}, {...valid,mimeType:'application/octet-stream'},
    {...valid,name:''}, {...valid,name:'x'.repeat(201)},
  ]) assert.throws(()=>assertCompletedSourceMetadata(invalid,expected),{code:'SOURCE_UPLOAD_INCOMPLETE'});
  assert.doesNotThrow(()=>assertCompletedSourceMetadata({...valid,mimeType:'application/pdf',size:String(MAX_SOURCE_BYTES)},expected));
});

test('bank uploads need no topic but retain their source and uploader ownership binding',()=>{
  const bankExpected={sourceId:'source-id',ownerId:'student-one',storagePath:'drive-file-id',folderId:'private-folder'};
  const bankFile={...valid,appProperties:{purpose:'hibi-study-source',sourceId:'source-id',ownerId:'student-one'}};
  assert.doesNotThrow(()=>assertCompletedSourceMetadata(bankFile,bankExpected));
  assert.throws(()=>assertCompletedSourceMetadata({...bankFile,appProperties:{...bankFile.appProperties,ownerId:'student-two'}},bankExpected),{code:'SOURCE_BINDING_MISMATCH'});
  assert.throws(()=>assertCompletedSourceMetadata({...bankFile,appProperties:{purpose:'hibi-study-source',sourceId:'source-id'}},bankExpected),{code:'SOURCE_BINDING_MISMATCH'});
  assert.throws(()=>assertCompletedSourceMetadata({...bankFile,appProperties:{...bankFile.appProperties,topicId:'unexpected-topic'}},bankExpected),{code:'SOURCE_BINDING_MISMATCH'});
});
