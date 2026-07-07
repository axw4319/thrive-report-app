#!/usr/bin/env bash
# Snapshot of the live-csv full batch progress.

ROOT=/Users/aaronwhittaker/Claude/thrive-report-app
LOG=$ROOT/tools/live-csv/test-output/missing-run.log
PID=54363

echo "── live-csv full-batch status ──"
if ps -p $PID > /dev/null 2>&1; then
  ELAPSED=$(ps -o etime= -p $PID | tr -d ' ')
  echo "  Status:   RUNNING (PID $PID, elapsed $ELAPSED)"
else
  echo "  Status:   FINISHED (or not started)"
fi

if [ -f "$LOG" ]; then
  GROUPS_LINE=$(grep -E "unique companies in [0-9]+ \(city, industry\)" "$LOG" | tail -1)
  TOTAL_GROUPS=$(echo "$GROUPS_LINE" | sed -E 's/.*in ([0-9]+) \(city.*/\1/' | head -c 6)
  TOTAL_COMPANIES=$(echo "$GROUPS_LINE" | sed -E 's/.*  ([0-9]+) unique.*/\1/' | head -c 6)
  GROUPS_DONE=$(grep -cE "^=== " "$LOG")
  PDFS_DONE=$(grep -cE "  \[pdf\] generated " "$LOG")
  PDF_ERRORS=$(grep -cE "  \[pdf\] ERROR" "$LOG")

  echo "  Phase 3:  $GROUPS_DONE / ${TOTAL_GROUPS:-?} groups (LLM queries)"
  echo "  Phase 4:  $PDFS_DONE / ${TOTAL_COMPANIES:-?} PDFs ($PDF_ERRORS errors)"
  echo
  echo "Last 5 log lines:"
  tail -5 "$LOG" | sed 's/^/  /'
else
  echo "  No log yet at $LOG"
fi

echo
echo "PDFs on disk: $(ls $ROOT/reports/ 2>/dev/null | wc -l | tr -d ' ')"
