---
name: claws-fix
description: Diagnose and fix Claws connection issues. Alias for /claws-doctor — both run the same 8-check health diagnostic with copy-pasteable fixes.
---

# /claws-fix

`/claws-fix` is now an alias for `/claws-doctor` — one self-contained diagnostic that replaces the previous 7-step manual flow.

## What to do

Run the doctor:

```bash
bash ~/.claws-src/scripts/doctor.sh
```

If `~/.claws-src` doesn't exist, the user hasn't installed yet:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

Let the doctor's output speak for itself — it prints every check, the fix for each failure, and a final verdict. Don't add commentary on top.

If everything passes, the user is ready: `/claws` for the dashboard.
