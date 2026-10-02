/** User control is unmeasured, never a passing or retryable scenario result. */
export function isScenarioUserControl(code: unknown): boolean {
  return (
    code === 'user_input_active' ||
    code === 'computer_user_control_active' ||
    code === 'computer_user_intervention_pending'
  );
}
