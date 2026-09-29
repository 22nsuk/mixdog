import type React from 'react';
import { ActivityRail } from '../ActivityRail';
import {
  WorkbenchSideIconBar,
  WorkbenchSidePanel,
  type WorkbenchSide,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewId,
} from '../workbench-side-view-layout';
import { SidebarDiffColumn } from '../sidebar-diff-column';
import { warmSettingsView } from '../app-shell-components';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { createAppSideViewDescriptors } from '../app-side-view-descriptors';
import type { useSideViewReordering } from '../app-shell-side-views';
import type { useAppSettingsRouter } from './use-app-settings-router';

export interface AppSidebarDrawerProps {
  sidebarOpen: boolean;
  sidebarMotion: ReturnType<typeof useAppShellPanels>['sidebarMotion'];
  settingsOpen: boolean;
  closeSidebarForNavigation: (motion?: 'animated' | 'instant') => void;
  openSettings: ReturnType<typeof useAppSettingsRouter>['openSettings'];
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];

  workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
  sideViewDescriptors: ReturnType<typeof createAppSideViewDescriptors>;
  activeSideViews: ReturnType<typeof useAppSideDocks>['activeSideViews'];
  selectWorkbenchSideView: (viewId: WorkbenchSideViewId) => void;
  moveWorkbenchSideGroup: ReturnType<typeof useSideViewReordering>['moveWorkbenchSideGroup'];
  moveWorkbenchSideView: ReturnType<typeof useSideViewReordering>['moveWorkbenchSideView'];
  renderWorkbenchSideView: (
    side: WorkbenchSide,
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps
  ) => React.ReactNode;

  sidebarDiff: ReturnType<typeof useAppSideDocks>['sidebarDiff'];
  closeSidebarDiff: () => void;
  openFileTab: (project: string, rel: string, line?: number) => void;
}

export function AppSidebarDrawer({
  sidebarOpen,
  sidebarMotion,
  settingsOpen,
  closeSidebarForNavigation,
  openSettings,
  setCommandSurface,
  workbenchSideLayout,
  sideViewDescriptors,
  activeSideViews,
  selectWorkbenchSideView,
  moveWorkbenchSideGroup,
  moveWorkbenchSideView,
  renderWorkbenchSideView,
  sidebarDiff,
  closeSidebarDiff,
  openFileTab,
}: AppSidebarDrawerProps) {
  return (
    <div className="sidebar-drawer-frame" data-state={sidebarOpen ? 'open' : 'closed'} data-motion={sidebarMotion}>
      <ActivityRail
        settingsOpen={settingsOpen}
        onOpenSettings={() => {
          closeSidebarForNavigation('instant');
          openSettings();
        }}
        onOpenProviders={() => {
          closeSidebarForNavigation('instant');
          openSettings('providers');
        }}
        onOpenUsageStats={() => setCommandSurface('stats')}
        onPrefetchSettings={warmSettingsView}
        navigationItems={workbenchSideLayout.layout.left.flatMap((group) => {
          const descriptor = sideViewDescriptors.get(group[0]);
          return descriptor ? [{ id: group[0], label: descriptor.tooltip || descriptor.label }] : [];
        })}
        primaryNavigation={
          <WorkbenchSideIconBar
            side="left"
            groups={workbenchSideLayout.layout.left}
            activeRoot={activeSideViews.left}
            descriptors={sideViewDescriptors}
            orientation="vertical"
            onSelect={selectWorkbenchSideView}
            onMoveGroup={moveWorkbenchSideGroup}
            onMoveView={moveWorkbenchSideView}
          />
        }
      />
      <WorkbenchSidePanel
        side="left"
        open={sidebarOpen}
        groups={workbenchSideLayout.layout.left}
        activeRoot={activeSideViews.left}
        descriptors={sideViewDescriptors}
        onSelect={selectWorkbenchSideView}
        onMoveGroup={moveWorkbenchSideGroup}
        onMoveView={moveWorkbenchSideView}
        renderView={(id, active, titleDragProps) => renderWorkbenchSideView('left', id, active, titleDragProps)}
      />
      <SidebarDiffColumn
        diff={sidebarDiff?.diff ?? null}
        showing={
          Boolean(sidebarDiff) &&
          sidebarOpen &&
          workbenchSideLayout.layout.left.length > 0 &&
          activeSideViews.left === sidebarDiff?.view
        }
        onClose={closeSidebarDiff}
        openFileTab={openFileTab}
      />
    </div>
  );
}
