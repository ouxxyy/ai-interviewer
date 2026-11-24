export type InterviewLanguage = 'zh' | 'en';

/** Match the highest-ranked supported language, including regional variants. */
export function requestLanguage(header?: string): InterviewLanguage {
  if (!header || header.trim() === '*') return 'zh';
  const preferences = header.toLowerCase().split(',').map(item => {
    const [tag, weight] = item.trim().split(';');
    const quality = weight === undefined ? 1 : Number(weight.trim().replace(/^q=/, ''));
    return { tag: tag?.trim().split('-')[0], quality };
  }).filter(item => item.quality > 0 && item.quality <= 1).sort((a, b) => b.quality - a.quality);
  for (const { tag } of preferences) if (tag === 'zh' || tag === 'en') return tag;
  return 'en';
}

export function interviewPrompt(prompt: string, language: InterviewLanguage): string {
  if (language === 'zh') return prompt;
  return prompt + '\n\nInterview language: English. Conduct this interview in English even when the supplied materials or rubric are in Chinese. ' +
    'Write all candidate-facing questions, follow-ups, intents, topics, feedback reasons, fact gaps, rewrite comparisons and practice suggestions in natural English. ' +
    'Preserve every JSON field, ID and required enum exactly as specified, including the Chinese level values. ' +
    'Never translate a source excerpt or quoted answer. Copy it verbatim from the original. For report priorities, reuse wording from validated feedback.';
}
