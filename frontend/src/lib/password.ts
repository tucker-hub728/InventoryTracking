/** Returns a 0..4 strength score for a password. */
export function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

export const PASSWORD_STRENGTH_LABELS: Record<number, string> = {
  0: 'Too short',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Excellent',
};
