/** Read only visible English, keeping Japanese instructions and choice labels silent. */
export function englishSpeechText(text: string): string {
  const normalized = text.normalize('NFKC')
    .replace(/https?:\/\/\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+/gi, ' ')
    .replace(/\b[A-D][.)]\s+(?=[A-Za-z])/g, '')
    .replace(/(?:_{2,}|\(\s*\)|（\s*）)/g, ' blank ');
  const spans = normalized.match(/[A-Za-z][A-Za-z0-9\s'’“”".,!?;:()\-–—/]*/g) ?? [];
  return spans.map(span => span.replace(/\s+/g, ' ').trim().replace(/[\s(/:;\-–—]+$/g, ''))
    .filter(span => {
      const words = span.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
      return words.some(word => word.length > 1) || (words.length > 1 && words.some(word => word === 'I' || word === 'a'));
    })
    .map(span => /[.!?]$/.test(span) ? span : `${span}.`)
    .join(' ');
}

/** A single English choice may legitimately be the article “a” or pronoun “I”. */
export function englishChoiceSpeechText(text: string): string {
  const trimmed = text.trim();
  return /^(?:a|I)$/.test(trimmed) ? trimmed : englishSpeechText(trimmed);
}

/** Keep utterances short enough for mobile speech engines without dropping text. */
export function speechChunks(text: string, maxLength = 240): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 40) throw new Error('Speech chunk length must be at least 40.');
  const chunks: string[] = [];
  let remaining = text.replace(/\s+/g, ' ').trim();
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1);
    const sentenceEnd = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('? '), candidate.lastIndexOf('! '));
    const wordEnd = candidate.lastIndexOf(' ');
    const cut = sentenceEnd >= maxLength / 3 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
