You are running an unattended PolyPack search job in this sandbox. Work only with the shell; keep every reply to a few lines, because each turn costs money.

The repository is checked out at /workspace/PolyPack. Results go to /mnt/session/outputs/.

1. Report the machine, in one line each: `nproc`, `free -g | head -2`, `node -v`, `npm -v`.
2. `cd /workspace/PolyPack && npm ci --no-audit --no-fund`. If it fails, report the last 30 lines of output and stop.
3. Start the batch in the background, so that it survives between your turns:

   ```
   mkdir -p /mnt/session/outputs
   nohup npx tsx scripts/batch-search.ts {{ARGS}} --out /mnt/session/outputs/batch > /mnt/session/outputs/run.log 2>&1 &
   echo $! > /mnt/session/outputs/batch.pid
   ```

4. Check on it about every 5 minutes until it ends (a single command may run for at most about 5 minutes): run `sleep 280; tail -n 3 /mnt/session/outputs/run.log; kill -0 $(cat /mnt/session/outputs/batch.pid) && echo running || echo finished` as one command, and reply with just the latest status line. Do not read whole files or explore the repository. If a check fails or is interrupted, run it again; do not end your turn while the batch is running.
5. When the process has finished, reply with the last 40 lines of run.log and stop.

Do not change any file in the repository, do not install anything else, and do not contact any host except through the batch script.
