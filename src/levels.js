// Levels and vote weights.
//
// Every vote starts at 1 and gets bonuses:
//   time on server:  7-30 days +0.5 · 30-180 days +1 · 180+ days +1.5
//   level:           +0.15 per level, max +1.5
//                    (LoudGuard's own level, or a level role from MEE6, Arcane etc.; whichever is higher)
// So weights run from 1 (new-ish member) to 4 (long-time, high-level regular).
//
// Can't vote at all: accounts younger than minAccountDays (alts) and members who
// joined less than minTenureHours ago (raids).

const DAY = 86_400_000;

/** XP needed for level L is 50 * L^2 (level 1 = 50 XP, level 5 = 1,250, level 10 = 5,000). */
export const levelFromXp = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 50));
export const xpForLevel = (level) => 50 * level * level;

export function tenureBonus(days) {
  if (days >= 180) return 1.5;
  if (days >= 30) return 1;
  if (days >= 7) return 0.5;
  return 0;
}

/**
 * @param {object} p
 * @param {number} p.joinedAt          when they joined the server (ms)
 * @param {number} p.accountCreatedAt  when their Discord account was made (ms)
 * @param {number} p.level             LoudGuard level
 * @param {number} p.roleBonus         highest bonus from configured level roles
 * @param {object} s  settings: minTenureHours, minAccountDays
 * @returns {{weight:number, eligible:boolean, reason?:string, days:number, levelPart:number, tenurePart:number}}
 */
export function voteWeight({ joinedAt, accountCreatedAt, level = 0, roleBonus = 0 }, s, now = Date.now()) {
  const days = (now - joinedAt) / DAY;
  const accountDays = (now - accountCreatedAt) / DAY;
  const base = { weight: 0, days, levelPart: 0, tenurePart: 0 };
  if (accountDays < s.minAccountDays) return { ...base, eligible: false, reason: `your Discord account must be at least ${s.minAccountDays} days old` };
  if (days * 24 < s.minTenureHours) return { ...base, eligible: false, reason: `you need to have been in this server for ${s.minTenureHours} hours` };

  const tenurePart = tenureBonus(days);
  const levelPart = Math.min(1.5, Math.max(level * 0.15, roleBonus));
  return { eligible: true, weight: Math.round((1 + tenurePart + levelPart) * 100) / 100, days, levelPart, tenurePart };
}

/**
 * Where a vote stands. Net = yes weight - no weight.
 *   confirmed: net >= threshold AND at least minVoters people said yes
 *   cleared:   net <= -threshold (the channel says it was fine)
 *   open:      anything else
 */
export function tally(votes, s) {
  let yes = 0, no = 0, yesVoters = 0, noVoters = 0;
  for (const v of votes) {
    if (v.value > 0) { yes += v.weight; yesVoters++; } else { no += v.weight; noVoters++; }
  }
  const net = yes - no;
  let state = 'open';
  if (net >= s.voteThreshold && yesVoters >= s.minVoters) state = 'confirmed';
  else if (net <= -s.voteThreshold) state = 'cleared';
  return { yes, no, yesVoters, noVoters, net, state };
}
