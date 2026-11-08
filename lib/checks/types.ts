export type CheckName = 'duplicate' | 'overcharge' | 'new_payee' | 'policy_limit';

/** One reason a bill needs the owner's attention, in plain English. */
export type Flag = {
  check_name: CheckName;
  reason: string;
};
