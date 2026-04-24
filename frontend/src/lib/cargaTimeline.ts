export interface ScheduledCargo {
  id: string;
  data: string;
  horario: string;
}

function compareCargoSchedule(itemA: ScheduledCargo, itemB: ScheduledCargo) {
  const dateCompare = itemA.data.localeCompare(itemB.data);
  if (dateCompare !== 0) {
    return dateCompare;
  }

  return itemA.horario.localeCompare(itemB.horario);
}

export function upsertCargoBySchedule<T extends ScheduledCargo>(items: T[], nextItem: T) {
  const remainingItems = items.filter((item) => item.id !== nextItem.id);
  const insertionIndex = remainingItems.findIndex((item) => compareCargoSchedule(nextItem, item) < 0);

  if (insertionIndex === -1) {
    return [...remainingItems, nextItem];
  }

  return [
    ...remainingItems.slice(0, insertionIndex),
    nextItem,
    ...remainingItems.slice(insertionIndex),
  ];
}
