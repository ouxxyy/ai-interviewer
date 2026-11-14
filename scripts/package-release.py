#!/usr/bin/env python3
"""为 ai-interviewer 生成生产部署包与 SHA256SUMS.txt，便于后续 Agent 通过 Computer Use 部署。"""
import os
import hashlib
import tarfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE_DIR = os.path.join(REPO_ROOT, "release")
DIST_DIR = os.path.join(REPO_ROOT, "dist")

def main():
    os.makedirs(RELEASE_DIR, exist_ok=True)
    tar_path = os.path.join(RELEASE_DIR, "ai-interviewer-dist.tar.gz")

    with tarfile.open(tar_path, "w:gz") as tar:
        for runtime_dir in ('src', 'web-client'):
            for root, dirs, files in os.walk(os.path.join(DIST_DIR, runtime_dir)):
                for file in files:
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, REPO_ROOT)
                    tar.add(full_path, arcname=rel_path)

    sha = hashlib.sha256(open(tar_path, "rb").read()).hexdigest()
    sums_file = os.path.join(RELEASE_DIR, "SHA256SUMS.txt")
    with open(sums_file, "w", encoding="utf-8") as f:
        f.write(f"{sha}  release/ai-interviewer-dist.tar.gz\n")

    print(f"Packed {tar_path} successfully. SHA256: {sha}")

if __name__ == "__main__":
    main()
