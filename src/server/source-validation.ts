import { ApiError,MAX_SOURCE_BYTES,SOURCE_MIME_TYPES } from './config';

export interface SourceMetadata {
  id:string;name:string;mimeType:string;size?:string;parents?:string[];
  appProperties?:Record<string,string>;
}

/** Bind completion to the exact upload capability originally issued by this app. */
export function assertCompletedSourceMetadata(file:SourceMetadata,expected:{sourceId:string;topicId?:string;ownerId?:string;storagePath:string;folderId:string}) {
  if(file.id!==expected.storagePath || !file.parents?.includes(expected.folderId)
    || file.appProperties?.purpose!=='hibi-study-source'
    || file.appProperties.sourceId!==expected.sourceId || file.appProperties.topicId!==expected.topicId
    || (expected.ownerId !== undefined && file.appProperties.ownerId !== expected.ownerId)) {
    throw new ApiError(403,'このアップロードを資料に登録できません。','SOURCE_BINDING_MISMATCH');
  }
  const size=Number(file.size);
  if(!Number.isSafeInteger(size) || size<=0 || size>MAX_SOURCE_BYTES
    || !SOURCE_MIME_TYPES.includes(file.mimeType as typeof SOURCE_MIME_TYPES[number])
    || !file.name.trim() || file.name.length>200) {
    throw new ApiError(422,'アップロードの完了・形式・サイズを確認してください。','SOURCE_UPLOAD_INCOMPLETE');
  }
}
