// Convex functions read their deployment's environment through process.env.
// Declared here instead of installing @types/node, which would also claim the
// Node APIs the default Convex runtime does not have.
declare const process: { env: Record<string, string | undefined> };
