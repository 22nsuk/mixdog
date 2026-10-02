(async () => {
  const { runDevTranscriptMotionProbe } = await import(
    '/@fs/C:/Project/mixdog/apps/desktop/scripts/composer-layout-probe/dev-motion.tsx'
  );
  const report = await runDevTranscriptMotionProbe();
  return report;
})();
