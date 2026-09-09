// The single failure every interactive-command response reader raises. The
// message text is part of the contract, not a debug string: the pane shows it
// as the card's failure line and omp-rpc-session-commands.test.ts asserts it
// verbatim per verb, so the per-family reader modules
// (omp-rpc-command-response-validation.ts and its siblings) all build it here
// rather than each spelling the sentence out.

export function malformedOmpRpcResponse(command: string): Error {
  return new Error(`OMP RPC ${command} response was malformed`)
}
