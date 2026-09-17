WHY THIS COPY IS INCOMPLETE
================================================================================
This directory is the client handoff package as committed to source control.

TWO THINGS ARE MISSING HERE, DELIBERATELY:

  project/                                    the complete source tree
      Excluded because it is a byte copy of this repository. Use the repository
      itself. The one difference is that the handoff ships the COMMITTED
      policy.py rather than any uncommitted working-tree edit, and renames
      run_final_r4.py -> run_final_model.py and live_board_r4.py -> live_board.py
      with the run tag _v1. Behaviour is identical; verified byte-identical
      output.

  project/betgenius/harness/uplift/data_expanded_6h/     329 MB, 25 files
      The data snapshot. Excluded because data files are git-ignored throughout
      this repository by policy. Every file's sha256 is recorded in
      reports/reproducibility.txt, and DATA_DOCUMENTATION.txt section 10
      documents how to regenerate it.

TO REBUILD THE FULL DELIVERABLE
  1. Copy this directory to a working folder.
  2. Create project/betgenius/ from this repository, excluding .git,
     node_modules and the cache directories.
  3. Add the data snapshot under
     project/betgenius/harness/uplift/data_expanded_6h/.
  4. HANDOFF_MANIFEST.txt lists every file the complete package contains.

Everything else -- the audit, the results, the reports, the documentation, the
scripts and the configuration -- is present and complete.
