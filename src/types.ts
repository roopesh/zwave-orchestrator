// Core domain types shared across the transport adapter, topology planner, and UI.

/** A source or target of an association. endpoint 0 = root device. */
export interface AssociationAddress {
  nodeId: number;
  endpoint?: number;
}

/** One association group advertised by a device (e.g. Inovelli group 3 "Multilevel Switch Set"). */
export interface AssociationGroup {
  id: number;
  label: string;
  maxNodes: number;
  isLifeline: boolean;
  multiChannel: boolean;
  profile?: number;
  /** CommandClass id -> command ids this group issues. The device-reported, brand-agnostic
   *  description of what the group actually does; we derive capabilities from it. */
  issuedCommands?: Record<number, number[]>;
}

/** A node as we care about it: identity + labels + product, transport-agnostic. */
export interface ZNode {
  id: number;
  name: string;
  location: string;
  product: string;
  status?: number;
  isController: boolean;
  /** Z-Wave Long Range node (protocol === 1). LR is hub-only: it CANNOT do direct associations. */
  isLongRange: boolean;
  /** highestSecurityClass; source & target must share a class or the association is silently unusable. */
  securityClass?: number;
}

/** Current associations of a node, keyed by group id. */
export type AssociationsByGroup = Record<number, AssociationAddress[]>;

/** A named option for a configuration parameter (e.g. {value:0, label:"Immediate"}). */
export interface ConfigOption {
  value: number;
  label: string;
}

/** A device configuration parameter (Command Class 112) with metadata + current value. */
export interface ConfigParam {
  param: number;
  label: string;
  description?: string;
  value: number | null;
  default?: number;
  min?: number;
  max?: number;
  unit?: string;
  writeable: boolean;
  options?: ConfigOption[];
}

/** A node enriched with its association groups + current associations (dump shape). */
export interface NodeDump extends ZNode {
  groups: AssociationGroup[];
  associations: AssociationsByGroup;
}
