/**
 * Maps AI response text to an LED eyes expression name.
 * Used so the robot's eyes react to what the AI is saying.
 */
const EXPRESSIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'blink',
  'sleepy',
  'love',
] as const;

export type EyeExpression = (typeof EXPRESSIONS)[number];

/** Keywords/phrases per expression (lowercase). First match wins. */
const EXPRESSION_KEYWORDS: Record<EyeExpression, string[]> = {
  sad: [
    'sorry', 'apolog', 'unfortunately', 'regret', 'sad', 'unable to',
    'i\'m sorry', 'we regret', 'unable to help',
  ],
  angry: [
    'cannot do that', 'can\'t do that', 'unacceptable', 'must not',
  ],
  love: [
    'love to', 'dear ', 'appreciate', 'glad you', 'thank you so much',
  ],
  happy: [
    'welcome', 'glad', 'happy to', 'great', 'thank you', 'thanks',
    'hello', 'hi ', 'good morning', 'good afternoon', 'good day',
    'pleasure', 'wonderful', 'excellent', 'good to hear', 'sure',
    'certainly', 'of course', 'absolutely', 'here you go', 'here is',
  ],
  surprised: [
    'oh ', 'really?', 'interesting', 'actually', 'let me check',
    'let me see', 'good question', '?',
  ],
  sleepy: [
    'goodbye', 'bye', 'good night', 'have a nice day', 'take care',
    'rest of your day', 'anything else?',
  ],
  blink: [],
  neutral: [],
};

export function eyeExpressionFromText(text: string): EyeExpression {
  const lower = text.toLowerCase().trim();
  if (!lower) return 'neutral';

  for (const [expr, keywords] of Object.entries(EXPRESSION_KEYWORDS) as [EyeExpression, string[]][]) {
    if (expr === 'neutral' || expr === 'blink') continue;
    for (const kw of keywords) {
      if (lower.includes(kw)) return expr;
    }
  }

  return 'neutral';
}
