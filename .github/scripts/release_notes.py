"""Preview the versioned action changelog and verify what was published."""

import json
import os
import re
import subprocess
import sys

TAG_PREFIX = "promptfoo-action-v"
RELEASE_BRANCH = "release-please--branches--main--components--promptfoo-action"
VERSION = r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?"
HEADER = re.compile(r"^#{2,3} \[(%s)\]\(" % VERSION, re.MULTILINE)


def run(*args, stdin=None):
    return subprocess.run(
        args, input=stdin, stdout=subprocess.PIPE, text=True, check=True
    ).stdout


def section(changelog, version, repository):
    """Take the current version's section verbatim, including inline and fenced code."""
    headers = []
    fence = None
    pos = 0
    for line in changelog.splitlines(keepends=True):
        delimiter = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            if re.fullmatch(
                r" {0,3}" + fence[0] + "{" + str(len(fence)) + r",}\s*", line
            ):
                fence = None
        elif delimiter:
            fence = delimiter[1]
        elif match := HEADER.match(line):
            headers.append((pos, match[1]))
        pos += len(line)
    if len(headers) < 2 or headers[0][1] != version:
        raise ValueError(
            f"Missing the leading {version} changelog or its previous release"
        )
    notes = changelog[headers[0][0] : headers[1][0]].strip()
    previous = TAG_PREFIX + headers[1][1]
    compare = (
        f"https://github.com/{repository}/compare/{previous}...{TAG_PREFIX}{version}"
    )
    if f"]({compare})" not in notes.splitlines()[0]:
        raise ValueError(f"Expected the changelog heading to link to {compare}")
    return notes, previous


def notes_at(sha, repo):
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("Expected a full commit SHA")
    version = json.loads(run("git", "show", f"{sha}:package.json"))["version"]
    if not re.fullmatch(VERSION, version):
        raise ValueError(f"Invalid package version: {version}")
    notes, previous = section(run("git", "show", f"{sha}:CHANGELOG.md"), version, repo)
    run("git", "merge-base", "--is-ancestor", f"refs/tags/{previous}", sha)
    return version, notes, previous


def coverage(previous, sha, notes, repo):
    """Surface conventional changes missing an explicit PR or commit link for review."""
    commits = run(
        "git", "log", "--first-parent", "--format=%H %s", f"refs/tags/{previous}..{sha}"
    )
    missing = []
    for line in commits.splitlines():
        commit, subject = line.split(" ", 1)
        if "[security]" not in subject and not re.match(
            r"^(?:(?:feat|fix|perf)(?:\([^)]*\))?!?|\w+(?:\([^)]*\))?!):", subject
        ):
            continue
        pr = re.search(r"\(#(\d+)\)$", subject)
        if re.search(r"/commit/" + commit[:7] + r"[a-f0-9]*\b", notes):
            continue
        if pr:
            number = pr[1]
            if re.search(rf"(?:/(?:issues|pull)/|#){number}\b", notes):
                continue
            missing.append(f"[#{number}](https://github.com/{repo}/pull/{number})")
        else:
            missing.append(f"[{commit[:7]}](https://github.com/{repo}/commit/{commit})")
    return missing


def api(path, body=None, method="POST"):
    if body is None:
        return json.loads(run("gh", "api", path))
    return json.loads(
        run(
            "gh",
            "api",
            "--method",
            method,
            path,
            "--input",
            "-",
            stdin=json.dumps(body),
        )
    )


def comment(repo, pr, kind, message):
    marker = f"<!-- promptfoo-action-release-{kind} -->"
    path = f"repos/{repo}/issues/{pr}/comments"
    rows = run("gh", "api", "--paginate", path, "--jq", ".[] | @json").splitlines()
    existing = next(
        (
            c
            for c in map(json.loads, rows)
            if c["user"]["login"] == "github-actions[bot]"
            and c["body"].startswith(marker)
        ),
        None,
    )
    body = {"body": f"{marker}\n\n{message}"}
    if not existing:
        api(path, body)
    elif existing["body"] != body["body"]:
        api(f"repos/{repo}/issues/comments/{existing['id']}", body, "PATCH")


def release_pr(pr, repo):
    return (
        pr["user"]["login"] == "github-actions[bot]"
        and (pr["head"]["repo"] or {}).get("full_name") == repo
        and pr["head"]["ref"] == RELEASE_BRANCH
        and pr["base"]["ref"] == "main"
    )


def preview(repo, number):
    pr = api(f"repos/{repo}/pulls/{int(number)}")
    if pr["state"] != "open" or not release_pr(pr, repo):
        return
    sha = pr["head"]["sha"]
    run("git", "fetch", "--no-tags", "origin", sha)
    _, notes, previous = notes_at(sha, repo)
    missing = coverage(previous, sha, notes, repo)
    feedback = (
        "Review changes without an explicit entry: " + ", ".join(missing)
        if missing
        else "All checked changes have a PR or commit reference."
    )
    source = f"https://github.com/{repo}/blob/{sha}/CHANGELOG.md"
    message = f"### Release notes preview\n\n[Changelog at `{sha[:7]}`]({source})\n\n{notes}\n\n---\n\n{feedback}"
    current = api(f"repos/{repo}/pulls/{pr['number']}")
    if current["state"] == "open" and current["head"]["sha"] == sha:
        comment(repo, pr["number"], "preview", message)


def remote_tag(tag):
    ref = f"refs/tags/{tag}"
    refs = {
        name: oid
        for oid, name in (
            row.split()
            for row in run("git", "ls-remote", "origin", ref, ref + "^{}").splitlines()
        )
    }
    return refs.get(ref, ""), refs.get(ref + "^{}", refs.get(ref, ""))


def publish(repo, sha, created_tag):
    run("git", "fetch", "--no-tags", "origin", sha)
    prs = api(f"repos/{repo}/commits/{sha}/pulls")
    pr = next(
        (
            p
            for p in prs
            if p["merged_at"] and p["merge_commit_sha"] == sha and release_pr(p, repo)
        ),
        None,
    )
    if not pr:
        if created_tag:
            raise ValueError(
                f"Cannot locate the merged release PR for {created_tag} at {sha}"
            )
        return
    url = f"https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    try:
        version, notes, _ = notes_at(sha, repo)
        tag = TAG_PREFIX + version
        if (created_tag and created_tag != tag) or remote_tag(tag)[1] != sha:
            raise ValueError(f"Expected the published {tag} tag at {sha}")
        release = api(f"repos/{repo}/releases/tags/{tag}")
        if release["draft"] or release["tag_name"] != tag:
            raise ValueError(f"{tag} is not a published release")
        if release["body"].strip() != notes:
            api(f"repos/{repo}/releases/{release['id']}", {"body": notes}, "PATCH")
            release = api(f"repos/{repo}/releases/tags/{tag}")
            if release["body"].strip() != notes:
                raise ValueError("Published notes differ from the tagged changelog")
        aliases = ["v" + version.split(".")[0], "v" + ".".join(version.split(".")[:2])]
        updates, leases = [], []
        for alias in aliases:
            oid, current = remote_tag(alias)
            if current == sha:
                continue
            if current:
                run("git", "fetch", "--no-tags", "origin", current)
                run("git", "merge-base", "--is-ancestor", current, sha)
            ref = f"refs/tags/{alias}"
            run("git", "tag", "-fa", alias, sha, "-m", f"Release {alias}")
            updates.append(ref)
            leases.append(f"--force-with-lease={ref}:{oid}")
        if updates:
            run("git", "push", "--atomic", *leases, "origin", *updates)
        for ref in [tag, *aliases]:
            if remote_tag(ref)[1] != sha:
                raise ValueError(f"{ref} does not resolve to {sha}")
        refs = ", ".join(f"`{ref}`" for ref in [tag, *aliases])
        message = (
            f"### Published\n\n[{version}]({release['html_url']}) uses the tagged changelog. "
            f"{refs} resolve to [`{sha[:7]}`](https://github.com/{repo}/commit/{sha}). "
            f"[Release workflow]({url})"
        )
    except Exception:
        comment(
            repo,
            pr["number"],
            "status",
            f"### Release needs attention\n\n[Inspect the release workflow]({url}).",
        )
        raise
    comment(repo, pr["number"], "status", message)


if __name__ == "__main__":
    repo = os.environ["GITHUB_REPOSITORY"]
    if sys.argv[1] == "preview":
        preview(repo, sys.argv[2])
    else:
        publish(repo, sys.argv[2], sys.argv[3])
