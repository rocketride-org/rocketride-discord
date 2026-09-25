// eval/bakeoff/enums.ts — the label vocabularies, shared by the generator, the validator and the
// review page. Kept in their own module so importing them never runs another file's CLI.
export const OUTCOMES = ['excluded', 'deferred', 'deferred_unanswered', 'overridden', 'dead_end', 'no_reply', 'rejected', 'reasked', 'resolved_confirmed', 'resolved_unconfirmed'] as const;
export const CAUSES = ['tool_error', 'engine_error', 'policy_public', 'policy_account', 'policy_other', 'product_defect', 'feature_request', 'content_gap', 'bad_answer', 'retrieval_miss', 'unknown'] as const;
/** `skip` means the CASE is broken (golden does not answer the question), not that you are unsure. */
export const VERDICTS = ['pass', 'partial', 'fail', 'skip'] as const;
/** Outcomes that are not failures — these must carry no cause. */
export const NON_FAILURE = ['resolved_confirmed', 'resolved_unconfirmed', 'excluded'] as const;
