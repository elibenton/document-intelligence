interface ViewerLayoutProps {
  viewer: React.ReactNode;
  sidebar: React.ReactNode;
}

export function ViewerLayout({ viewer, sidebar }: ViewerLayoutProps) {
  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 flex justify-center">
        {viewer}
      </div>
      <div className="w-80 border-l overflow-y-auto p-4">
        {sidebar}
      </div>
    </div>
  );
}
