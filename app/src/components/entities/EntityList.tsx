import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { EntityCard } from "./EntityCard";
import { Skeleton } from "@/components/ui/skeleton";

export function EntityList({
  type,
  title,
}: {
  type: string;
  title: string;
}) {
  const entities = useQuery(api.entities.listByType, { type });

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-2">
        {entities === undefined ? (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </>
        ) : entities.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No {title.toLowerCase()} found yet.
          </p>
        ) : (
          entities.map((entity) => (
            <EntityCard key={entity._id} entity={entity} />
          ))
        )}
      </div>
    </div>
  );
}
