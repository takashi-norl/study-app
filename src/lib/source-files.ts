/** Prepare photos on the device, keeping uploads small and removing EXIF location. */
export async function prepareSourceFile(file: File): Promise<File> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} は10MBを超えています。PDFを分割して追加してください。`);
    return file.type === 'application/pdf' ? file : new File([file], file.name, { type: 'application/pdf' });
  }
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new Error(`${file.name} は写真またはPDFを選んでください。`);
  }
  if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} は写真の容量が大きすぎます。小さくして追加してください。`);
  const url = URL.createObjectURL(file);
  const picture = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve();
      picture.onerror = () => reject(new Error(`${file.name} を読み込めませんでした。写真アプリからJPEGで保存するか、スクリーンショットで追加してください。`));
      picture.src = url;
    });
    if (!picture.naturalWidth || !picture.naturalHeight) throw new Error('写真のサイズを読み取れませんでした。');
    const ratio = Math.min(1, 2400 / Math.max(picture.naturalWidth, picture.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(picture.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('写真を準備できませんでした。ページを開き直してください。');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('写真の変換に失敗しました。')), 'image/jpeg', 0.9));
    canvas.width = canvas.height = 1;
    if (blob.size > 5 * 1024 * 1024) throw new Error(`${file.name} の写真が大きすぎます。ページを分けて撮影してください。`);
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    picture.src = '';
    URL.revokeObjectURL(url);
  }
}
