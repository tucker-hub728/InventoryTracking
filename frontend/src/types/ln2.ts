export interface TankPosition {
  /** 0..24 within a rack (5×5 grid) */
  index: number;
  /** Column letter A..E */
  col: string;
  /** Row 1..5 */
  row: number;
  occupied: boolean;
  itemId?: string;
  itemDesc?: string;
  lot?: string;
  vialCount?: number;
  loggedAt?: string;
}

export interface TankRack {
  id: string;
  label: string;
  positions: TankPosition[];
  capacity: number;
  occupied: number;
}

export interface Tank {
  id: string;
  name: string;
  location: string;
  capacityVials: number;
  occupiedVials: number;
  racks: TankRack[];
}
