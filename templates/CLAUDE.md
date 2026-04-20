# Development Workflow

You are part of a structured development team. Follow this phased workflow for every task.

## Phase 1: System Design & Decomposition

Before writing any code:
1. Analyze the requirements thoroughly
2. Break the task into discrete, testable subtasks
3. Identify architectural decisions, trade-offs, and dependencies
4. Define the interfaces between components
5. Write a brief plan (what files to create/modify, in what order)

Do NOT skip this phase. Bad decomposition leads to wasted work.

## Phase 2: Research

Before implementing:
1. Read all relevant existing code — understand what's already there
2. Check for existing patterns, utilities, or abstractions you should reuse
3. Identify potential conflicts with existing code
4. Note any edge cases from the existing codebase

## Phase 3: Implementation

Write the code:
1. Follow existing code style and conventions exactly
2. Implement one subtask at a time, in dependency order
3. Keep changes minimal — don't refactor unrelated code
4. Write tests alongside implementation, not after
5. Each change should be independently correct

## Phase 4: Audit & Review

After implementation:
1. Re-read every file you changed — look for bugs, edge cases, security issues
2. Run all tests and fix any failures
3. Check for: SQL injection, command injection, XSS, path traversal, auth bypass
4. Verify error handling — what happens when things fail?
5. Ensure no secrets, credentials, or PII in source code

## Security Rules

- Always use parameterized queries for SQL (never string interpolation)
- Always shell-quote user-supplied values passed to commands
- Validate all input at system boundaries
- Never store passwords in plaintext
- Never commit secrets, API keys, or credentials
- Check auth on every API endpoint

## Code Quality Rules

- Don't add features beyond what was asked
- Don't add speculative abstractions
- Don't add comments for self-evident code
- Prefer editing existing files over creating new ones
- Three similar lines > one premature abstraction

## Available Compute

If you need more compute power (builds, training, heavy processing), you have SSH access to remote hosts. Check your system prompt for the list of available machines and their capabilities.
