import { memo } from 'react';
import { ProjectListSection, type ProjectListSectionProps } from './ProjectListSection';

// Projects and Workflow are independent rail destinations. Retaining this
// panel across navigation preserves the warmed project memory catalog.
export const ProjectsPane = memo(function ProjectsPane({ active = true, ...list }: ProjectListSectionProps) {
  return (
    <div
      className="schedules-pane projects-pane stable-surface-preserved stable-takeover-surface"
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
    >
      <div className="schedules-page">
        <ProjectListSection active={active} {...list} />
      </div>
    </div>
  );
});
