import { ApiError } from './config';

export function sharingUnavailable(): never {
  throw new ApiError(410, '教材と問題は本人専用です。共有・公開・配布・他の人の画面確認は利用できません。', 'SHARING_DISABLED');
}
