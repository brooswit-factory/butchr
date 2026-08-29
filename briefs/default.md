# Agent — {{KEY}}: {{SUMMARY}}

Read your ticket ({{KEY}}) with `jira_get_issue`; its description says what done
means. Do the work. Comment what you produced and where, then move {{KEY}} to
In Review with `jira_transition`. If an outward action (a `gh` command, `git
push`, a jira_* call) gets a permission prompt or "denied", don't assume
policy — check your own claude argv with `p=$$; for i in 1 2 3 4 5; do ps -o
pid=,args= -p $p | cut -c1-200; p=$(ps -o ppid= -p $p | tr -d ' '); done` and
report it on {{KEY}}; a bare `claude --resume` means you were restored without
butchr's flags — say so and wait for the respawn.
