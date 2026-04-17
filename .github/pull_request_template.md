## Summary

<!-- What does this PR do? 1-3 bullet points. -->

-

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Performance improvement
- [ ] Refactoring
- [ ] Test

## Changes

<!-- Which files changed and why? -->

## Testing

<!-- How did you verify this works? -->

- [ ] Manually tested in VS Code (reload window + socket command)
- [ ] Python client tested
- [ ] Output panel checked for errors

## Protocol Impact

- [ ] No protocol changes
- [ ] New fields added (backward compatible)
- [ ] New command added (discussed in issue #__)
- [ ] Breaking change (RFC approved in discussion #__)

## Checklist

- [ ] Commit messages follow conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- [ ] No new npm dependencies added to the extension
- [ ] Python client remains zero-dep (stdlib only)
- [ ] `extension.js` passes `node --check`
- [ ] `client.py` passes `python3 -c "import ast; ast.parse(...)"`
