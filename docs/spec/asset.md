# Asset Management core: alm_asset, alm_hardware, models, stockrooms, asset and CI sync, contracts

Implementation spec for ResolvrNow. Companion specs: `cmdb.md` (CI classes, `install_status`, `operational_status`, `cmdb_ci_hardware`), `sla.md` (service contracts used by SLAs). Table and choice data that the SDK JSON lacks is in `docs/spec/data/cmdb-sla.json`.

**Legend.** **[Documented]**: stated in the public ServiceNow docs corpus or present in the SDK-derived model (`server/src/schema/sdk/sdk-tables.json` (formerly `sdk-tables.json`), cited as "SDK"). **[Inferred]**: general platform knowledge or a ResolvrNow design decision that the corpus does not confirm; safe to change. In tables, the Basis column uses **D** (Documented) and **I** (Inferred).

**ResolvrNow conventions.** All asset classes live in the root physical table `alm_asset` (table per hierarchy, told apart by `sys_class_name`); all CI classes live in `cmdb`. Date-times are stored UTC `YYYY-MM-DD HH:MM:SS`, dates `YYYY-MM-DD`. "Today" means the current UTC date **[Inferred]**. Business rules are TypeScript. Two write kinds matter below **[Inferred]**: a **sync write** is issued by the asset/CI sync routines with `ctx.sync = true` (6.2, 6.8); a **system write** is any write that does not come from REST or the UI (sync writes, event handlers, scheduled jobs). Mandatory-field checks apply to REST and UI writes only.

## 1. Scope and sources

In scope: asset classes and fields, State/Substate lifecycle, product models and model categories, stockrooms (basic), asset and CI synchronization, contract basics. Out of scope: Software Asset Management entitlements, procurement and purchase orders, cloud cost, HAM workspace flows (RMA, loaners, attestation, put away, picking, disposal orders), depreciation math, Install Base Item (IBI) sync.

Sources:
- https://www.servicenow.com/docs/r/it-asset-management/asset-management/it-asset-management.html
- https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/exploring-ham.html
- https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/configuring-ham.html
- https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/reference-hardware-asset-management.html

**Corpus gap.** The captured docs do not contain the base Asset Management pages (the CMDB docs point to "Map asset state and CI hardware status" and "Retire assets", which are not in the corpus). The SDK gives the asset fields but no State choices. State codes, substates and mapping rows below are therefore mostly **[Inferred]**, and they are aligned with the CSDM tangible life-cycle values, which are **[Documented]**.

## 2. Asset classes and key fields

Sources: https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_TaskTableFlattening.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/ai-assets-inventory-api.html, SDK.

| Class | Table | Extends | Notes | Basis |
|---|---|---|---|---|
| Asset | `alm_asset` | (root) | Base class; audited; holds every asset row in ResolvrNow | D |
| Hardware | `alm_hardware` | `alm_asset` | Serialized physical items; adds `eligible_for_refresh` (boolean) | D |
| Consumable | `alm_consumable` | `alm_asset` | Quantity tracked; never linked to a CI | D (table), I (behaviour) |
| Software License | `alm_license` | `alm_asset` | Legacy license asset; never linked to a CI | D (table), I (behaviour) |
| Facility | `alm_facility` | `alm_asset` | Facility equipment | D (table) |

AI digital asset classes (`alm_ai_*_digital_asset`) exist in the platform but are out of scope **[Documented]**.

Key `alm_asset` fields (all **[Documented]** in the SDK; meaning column is **[Inferred]** where the SDK only gives a label):

| Field | Type | Meaning in ResolvrNow |
|---|---|---|
| `asset_tag` | string | Business identifier (barcode/label). Not unique-enforced. |
| `serial_number` | string(100) | Manufacturer serial. Synced with the CI. |
| `display_name` | string(255) | Display field, computed (see below). |
| `model` / `model_category` | ref `cmdb_model` / ref `cmdb_model_category` | Product model and the category that decides asset class and CI class. |
| `ci` | ref `cmdb_ci` | Linked CI (pair of `cmdb_ci.asset`). |
| `install_status` (label "State") | integer, default 1 | Lifecycle state (section 3). |
| `substatus` (label "Substate") | string, dependent on `install_status` | Sub-state; SDK default expression sets `available` when State is 6. |
| `stockroom` | ref `alm_stockroom` | Where an in-stock asset sits. |
| `location`, `department`, `cost_center`, `company` | refs | Placement and ownership. Synced with the CI. |
| `assigned_to`, `assigned` | ref `sys_user`, date-time | Current user and assignment time. Synced with the CI. |
| `reserved_for` | ref `sys_user` | Target user while Substate is `reserved`. |
| `owned_by`, `managed_by`, `support_group`, `supported_by` | refs | Accountability. Synced with the CI. |
| `quantity` | integer, default 1 | Consumables only; hardware is always 1. |
| `parent` | ref `alm_asset` | Bundle or pallet parent. |
| `pre_allocated` | boolean | Vendor-owned stock held for just-in-time procurement **[Documented]**. |
| `active_to` | boolean | True while the asset is on an open transfer order line. |
| `install_date`, `retired`, `retirement_date`, `disposal_reason` | dates/string | Deployment date, actual retirement date, planned retirement date, reason. |
| `old_status`, `old_substatus` | string | Previous State and Substate, kept on every state change. |
| `cost`, `po_number`, `invoice_number`, `purchase_date`, `order_date`, `delivery_date`, `lease_id`, `warranty_expiration`, `gl_account` | financial | Procurement data. Synced with the CI. |
| `life_cycle_stage`, `life_cycle_stage_status` | refs | CSDM life-cycle pair (section 6.10). |
| `product_instance_id` | string | Product instance key shared by asset, CI and IBI. |
| `skip_sync` | boolean, default false | Suppresses asset and CI sync for one write (6.7). |

Derived values **[Inferred]**:
1. `display_name` = `asset_tag + " - " + model.display_name` (fall back to `model.name`; if `asset_tag` is empty, the model part alone). Recomputed when `asset_tag` or `model` changes.
2. `alm_hardware.quantity` is forced to 1 on every write.
3. `assigned` is set to now when `assigned_to` changes to a non-empty value and cleared when `assigned_to` is cleared, unless the caller set `assigned` explicitly in the same write.
4. If `model_category` is empty and the model lists exactly one category, that category is used; if it lists several, a REST or UI insert is rejected until a category is chosen. A chosen category must be one of the model's categories.

## 3. Lifecycle: State and Substate

Sources: https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/csdm-lifecycle-df-tangible-physical.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/csdm-lifecycle-map-csdm-to-asset.html, https://www.servicenow.com/docs/r/it-service-management/change-management/change_mgmt-integ-with-HWAM.html

The CSDM pairs (stage / status) in the tables below are **[Documented]** values; their attachment to each legacy code is **[Inferred]** except where noted. The asset state alignment Ordered, In Stock, In Use, In Maintenance, Pending Disposal, Disposed is **[Documented]**.

### 3.1 State (`alm_asset.install_status`)

| Value | Label | Allowed substates | CSDM pair | Basis |
|---|---|---|---|---|
| 1 | In use | (none) | Operational / In Use (documented example) | I |
| 2 | On order | (none) | Purchase / On Order | I |
| 3 | In maintenance | (none) | Operational / In Maintenance | I |
| 6 | In stock | see 3.2, default `available` | per substate | D (6 from SDK default), I |
| 7 | Retired | see 3.2, may be empty | End of Life / per substate | I |
| 8 | Missing | `lost` (default), `stolen` | Missing / Lost or Stolen | I |
| 9 | In transit | (none) | Deploy / In Transit | I |
| 10 | Consumed | (none); `alm_consumable` only | none (TBD) | I |
| 11 | Build | (none) | Design / Build | I |

### 3.2 Substate (`alm_asset.substatus`, dependent on State)

| State | Value | Label | CSDM pair | Basis |
|---|---|---|---|---|
| 6 | `available` | Available | Inventory / Available | D (SDK default), I |
| 6 | `reserved` | Reserved | Inventory / Reserved | I |
| 6 | `pre_allocated` | Pre-allocated | Inventory / Preallocated | I |
| 6 | `defective` | Defective | Defective / In Stock (documented example) | I |
| 6 | `pending_repair` | Pending repair | Inventory / Pending Repair | I |
| 6 | `pending_install` | Pending install | Deploy / In Stock | I |
| 6 | `pending_transfer` | Pending transfer | Deploy / Pending Transfer | I |
| 6 | `pending_disposal` | Pending disposal | End of Life / Pending Disposal | D (used by change integration), I |
| 7 | `disposed` | Disposed | End of Life / Disposed | I |
| 7 | `sold` | Sold | End of Life / Sold | I |
| 7 | `donated` | Donated | End of Life / Donated | D (CI substatus example), I |
| 7 | `vendor_credit` | Vendor credit | End of Life / Vendor Credit | I |
| 7 | `rma` | RMA | End of Life / RMA | I |
| 7 | `lease_return` | Lease return | End of Life / Lease Return | I |
| 7 | `buyout` | Buyout | End of Life / Buyout | I |
| 7 | (empty) | (none) | End of Life / Disposed | I |
| 8 | `lost` | Lost | Missing / Lost | I |
| 8 | `stolen` | Stolen | Missing / Stolen | I |

Note: one CSDM doc example maps a CI set to Retired/Donated to "End of Life / Retired"; ResolvrNow follows the tangible definitions table (End of Life / Donated) **[Inferred]**.

### 3.3 Transitions

ResolvrNow does not enforce a transition graph; any State may follow any other, as in the base platform **[Inferred]**. Only pair validity and mandatory fields (3.4) are enforced. Typical paths: On order → In transit → In stock/available → In stock/reserved → In use → In maintenance → In use → In stock/pending_disposal → Retired/disposed; In use → Missing/stolen.

### 3.4 Asset before insert/update rule (order matters) **[Inferred]**

Let `prev` be the stored row (empty on insert) and `stateChanged = install_status != prev.install_status`.

1. Class check: `install_status = 10` is allowed only when `sys_class_name = alm_consumable`; otherwise reject with `Invalid State for this asset class`.
2. Substate normalization: if `substatus` is not allowed for the new State (3.1, 3.2): when the caller did not set `substatus` in this write, replace it with the State default (`available` for 6, `lost` for 8, empty otherwise); when the caller did set it, reject with `Substate <v> is not valid for State <s>`.
3. History: if `stateChanged`, set `old_status = prev.install_status`, `old_substatus = prev.substatus`.
4. State 6 (In stock): `stockroom` mandatory for REST and UI writes (system writes may leave it empty); if `stockroom` changed and is set, `location = stockroom.location`; when entering 6 from another State, clear `assigned_to` and `assigned`.
5. Substate `reserved`: `reserved_for` mandatory for REST and UI writes; for other substates `reserved_for` is cleared.
6. State 1 (In use): when entering 1, clear `stockroom` and `reserved_for`; set `install_date = now` if empty.
7. State 7 (Retired): when entering 7, set `retired = today` if empty and clear `assigned_to`, `assigned`. When leaving 7, clear `retired`.
8. Recompute `display_name`, `assigned`, hardware `quantity` (section 2).
9. Optional CSDM pair (6.10).

On a sync write, the parts of steps 4, 6 and 7 that modify a field from the 6.3 list (`location`, `assigned_to`, `assigned`, `install_date`) are skipped, so the asset and its CI never diverge; asset-only fields (`retired`, `stockroom`, `reserved_for`, `old_status`) are still maintained.

## 4. Models and model categories

Sources: https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/foundation-domain.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/cmdb-asset-CI-IBI-sync-options.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/ai-assets-inventory-api.html, SDK.

Product models are stored in `cmdb_model` and its classes `cmdb_hardware_product_model`, `cmdb_consumable_product_model`, `cmdb_facility_product_model`, `cmdb_contract_product_model`, `cmdb_software_product_model`, `cmdb_application_product_model`, `cmdb_service_product_model`. Models are not CIs; CIs point to them through `model_id` **[Documented]**.

`cmdb_model` fields used by this spec (SDK, **[Documented]**): `name`, `display_name`, `manufacturer`, `model_number`, `cmdb_model_category` (glide_list of categories), `cmdb_ci_class` (string, model-level CI class override), `asset_tracking_strategy` (default `leave_to_category`), `status` (default `In Production`), `bundle`, `depreciation`, `salvage_value`, `expected_lifespan`, `life_cycle_stage(_status)`.

`asset_tracking_strategy` choices **[Inferred]** (only the default value is documented): `leave_to_category` (use the category), `track_as_consumable` (create `alm_consumable` rows, no CI), `do_not_track` (never create assets for this model).

`cmdb_model_category` (not in SDK). The `asset_class` field is **[Documented]**; the rest is **[Inferred]**:

| Field | Type | Meaning |
|---|---|---|
| `name` | string(100) | Category name (Computer, Server, Network Gear...). |
| `asset_class` | table_name | Asset table created for models of this category (`alm_hardware`, `alm_consumable`, `alm_license`, `alm_facility`). Empty = no asset. |
| `cmdb_ci_class` | table_name | CI class created for assets of this category. Empty = no CI. |
| `enforce_verification` | boolean | When true, CIs inserted for this category by any path other than asset sync get `unverified = true`. |
| `allow_as_master`, `allow_in_bundle` | boolean | Bundle parent / bundle member permission (asset bundles are documented as a HAM feature). |
| `product_instance` | boolean | Category takes part in asset/CI/IBI product instance sync (documented concept, field name inferred). |

Resolution algorithm **[Inferred]**:
- Asset class for a new asset: if `model.asset_tracking_strategy = do_not_track`, no asset may be created automatically (manual insert is still allowed); if `track_as_consumable`, `alm_consumable`; otherwise `model_category.asset_class`. A row inserted through the base table `alm_asset` gets `sys_class_name` set to that class.
- CI class for an asset: `model.cmdb_ci_class` if set, else `model_category.cmdb_ci_class`; none for `alm_consumable` and `alm_license`.
- Category for a CI without asset: among `ci.model_id.cmdb_model_category`, the first whose `cmdb_ci_class = ci.sys_class_name`; if the CI has no model, the first category (by name) whose `cmdb_ci_class` equals the CI class exactly. No match means no asset.
- Unknown model: a seeded hardware model named `Unknown` is used when a CI without `model_id` needs an asset; the CI gets the same model. The CMDB Instance API examples show a new Linux server whose `asset` and `model_id` both display "Unknown", consistent with this rule **[Documented example]**.

Seed categories **[Inferred]**: Computer (`alm_hardware`, `cmdb_ci_computer`), Server (`alm_hardware`, `cmdb_ci_server`), Network Gear (`alm_hardware`, `cmdb_ci_netgear`), Storage Device (`alm_hardware`, `cmdb_ci_storage_device`), Rack (`alm_hardware`, `cmdb_ci_rack`), Computer Peripheral (`alm_hardware`, `cmdb_ci_peripheral`), Printer (`alm_hardware`, `cmdb_ci_printer`), Consumable (`alm_consumable`, none), Software License (`alm_license`, none). Rack and peripheral classes are listed as tangible CMDB tables in CSDM **[Documented]**.

## 5. Stockrooms

Sources: https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/configuring-ham.html, https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/reference-hardware-asset-management.html

Documented facts: stockrooms are physical places where hardware waits before deployment or after return; they are configured with types, stock rules, service locations and distribution channels; stockroom types are categories of stockrooms **[Documented]**. `cmn_location.stock_room` (boolean) exists in the SDK **[Documented]**. Field lists below are **[Inferred]**.

| Table | Fields |
|---|---|
| `alm_stockroom` | `name` (mandatory), `type` (ref `alm_stockroom_type`), `location` (ref `cmn_location`, mandatory), `manager` (ref `sys_user`), `assignment_group` (ref `sys_user_group`), `company`, `external` (boolean), `active` (default true) |
| `alm_stockroom_type` | `name`, `description` |
| `alm_stock_rule` | `stockroom`, `model`, `threshold` (integer), `restocking_option` (`stockroom` or `vendor`), `parent_stockroom`, `order_size` (integer), `active` |
| `alm_transfer_order` | `number` (prefix TRO), `from_stockroom`, `to_stockroom`, `stage` (`draft`, `requested`, `in_transit`, `received`, `cancelled`), `ship_date`, `received_date` |
| `alm_transfer_order_line` | `transfer_order`, `asset`, `model`, `quantity_requested`, `stage` (same choices) |

Rules **[Inferred]**: (a) inserting a stockroom sets `location.stock_room = true`; (b) a stockroom with assets in it cannot be deleted (reject); (c) stock rule job (hourly): count assets with `install_status=6^substatus=available^stockroom=<s>^model=<m>`; when the count is below `threshold`, fire event `stock_rule.threshold_reached` (parm1 = rule sys_id, parm2 = count) once per breach, tracked by the ResolvrNow-internal flag `alm_stock_rule.breach_active` (cleared when the count recovers); (d) transfer order basics: line stage `requested` sets the asset to 6/`pending_transfer` and `active_to = true`; `in_transit` sets State 9; `received` sets State 6/`available`, `stockroom = to_stockroom`, `active_to = false`. Transfer orders are optional for ResolvrNow v1.

## 6. Asset and CI synchronization

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/cmdb-ci-lifecycle-mgmt.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/class-hardware.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/cmdb-asset-CI-IBI-sync-options.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/csdm-life-cycle-standard-values.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-instance-api.html

Documented anchors:
- A CI's Status (and Hardware Status for hardware) is kept in step with the linked asset's State, in both directions; `hardware_status` exists to sync status with the asset **[Documented]**.
- Legacy mapping rows live in `alm_asset_ci_state_mapping` and `alm_hardware_state_mapping` **[Documented names]**.
- Asset In use gives CI Installed with substatus In use; CI Retired with substatus Donated gives the asset Retired/Donated **[Documented examples]**.
- Inside the CI, Operational Status and Status are coupled around Retired (6.6) **[Documented]**.

### 6.1 Links
`alm_asset.ci` → CI and `cmdb_ci.asset` → asset form a 1:1 pair kept consistent by the engine: writing one side sets the other (sync write). A CI may be linked to at most one asset and vice versa; linking a CI already linked elsewhere is rejected **[Inferred]**. When two existing records are linked, the side whose write created the link wins: its non-empty synced values and its status overwrite the other side **[Inferred]**. Changing or clearing a link clears the back-reference on the previously linked record.

### 6.2 Creation **[Inferred]**
- **Asset → CI** (after insert of an asset): if `ci` is empty, `skip_sync` is false, the write is not a sync write, property `resolvr.asset.auto_create_ci` is true and a CI class resolves (section 4): create a CI of that class with `name = display_name` (or `serial_number`, or `asset_tag`), `model_id = model`, `manufacturer = model.manufacturer`, all fields of 6.3 copied, status fields from 6.4, `asset = <asset>`; then set `asset.ci`.
- **CI → asset** (after insert of a CI): if `asset` is empty, same guards with property `resolvr.asset.auto_create_asset`, and a category resolves: create an asset of the resolved class with `model` (or `Unknown`), `model_category`, fields of 6.3 copied, State/Substate from 6.5, `ci = <ci>`; then set `ci.asset`.
- `alm_consumable` and `alm_license` rows never create or link CIs.

### 6.3 Synchronized fields (same name on both sides unless shown) **[Inferred]**
The list is the set of non-system fields that the SDK defines on both `cmdb` and `alm_asset` (minus `install_status`, mapped in 6.4, and `skip_sync`, see 6.7), plus `product_instance_id` and the life-cycle pair shared with `cmdb_ci`, plus renamed pairs; `comments` is deliberately not synced. Direction is both ways; a change on either side is copied to the other in the same transaction.

| Asset field | CI field | Notes |
|---|---|---|
| `asset_tag`, `serial_number` | same | |
| `assigned_to`, `assigned` | same | |
| `owned_by`, `managed_by`, `support_group`, `supported_by` | same | |
| `company`, `department`, `cost_center`, `location` | same | |
| `vendor` | same | |
| `cost` | `cost` (+ `cost_cc`) | CI `cost_cc` takes the asset currency, default USD |
| `po_number`, `invoice_number`, `purchase_date`, `order_date`, `delivery_date` | same | |
| `install_date`, `checked_in`, `checked_out`, `due`, `due_in`, `gl_account`, `justification`, `lease_id`, `warranty_expiration` | same | |
| `model` | `model_id` | CI `manufacturer` follows `model.manufacturer` (one way) |
| `product_instance_id` | same | documented as synchronized across representations |
| `install_status` + `substatus` | `install_status`, `hardware_status`, `hardware_substatus` | via 6.4 and 6.5, not copied |
| `life_cycle_stage`, `life_cycle_stage_status` | same | only when 6.10 is enabled |

### 6.4 Asset State → CI status (`alm_asset_ci_state_mapping`, `alm_hardware_state_mapping`) **[Inferred]**

| Asset State | Asset Substate | CI `install_status` | `hardware_status` | `hardware_substatus` |
|---|---|---|---|---|
| 1 In use | any | 1 Installed | `installed` | `in_use` |
| 2 On order | any | 2 On Order | `on_order` | (empty) |
| 3 In maintenance | any | 3 In Maintenance | `in_maintenance` | (empty) |
| 6 In stock | `pending_install` | 4 Pending Install | `in_stock` | `pending_install` |
| 6 In stock | `pending_repair` | 5 Pending Repair | `in_stock` | `pending_repair` |
| 6 In stock | any other | 6 In Stock | `in_stock` | same as substate |
| 7 Retired | any | 7 Retired | `retired` | same as substate |
| 8 Missing | `stolen` | 8 Stolen | `missing` | `stolen` |
| 8 Missing | `lost` or empty | 100 Absent | `missing` | `lost` |
| 9 In transit | any | 6 In Stock | `in_transit` | (empty) |
| 11 Build | any | 4 Pending Install | `build` | (empty) |

`hardware_status` and `hardware_substatus` are written only when the CI class is `cmdb_ci_hardware` or a descendant (`INSTANCEOF cmdb_ci_hardware`). `hardware_status` mirrors asset States as strings and `hardware_substatus` mirrors asset Substates plus `in_use` (documented values: `installed`, `in_use`, `retired`, `donated`).

### 6.5 CI status → asset State **[Inferred]**

| CI value | Asset State / Substate |
|---|---|
| `install_status` 1 | 1 / empty |
| 2 | 2 / empty |
| 3 | 3 / empty |
| 4 | 6 / `pending_install` |
| 5 | 6 / `pending_repair` |
| 6 | 6 / `available` |
| 7 | 7 / empty |
| 8 | 8 / `stolen` |
| 100 | 8 / `lost` |
| `hardware_status` `installed` / `on_order` / `in_maintenance` / `in_transit` / `build` | 1 / 2 / 3 / 9 / 11, Substate empty |
| `hardware_status` `in_stock`, `retired`, `missing` | 6 / 7 / 8, Substate = `hardware_substatus` if valid for that State, else the State default |

For hardware CIs the hardware pair is used when it changed in the write; otherwise `install_status` is used. **No-op rule:** if the asset's current State/Substate already maps (6.4) to the CI's new values, the asset is not written. This keeps substate detail that the CI cannot express (for example an asset in 6/defective whose non-hardware CI is set to In Stock stays defective) and prevents state flapping.

### 6.6 CI-internal status coupling (CI before insert/update)

Documented behaviour **[Documented]**: (a) `operational_status` set to Retired forces Status (and Hardware Status) to Retired; (b) Status or Hardware Status set to Retired forces `operational_status` to Retired; (c) `operational_status` leaving Retired sets Status/Hardware Status to Installed; (d) Status/Hardware Status leaving Retired sets `operational_status` to Non-Operational. ResolvrNow algorithm (codes per `cmdb.md`: install 7 Retired, 1 Installed; operational 6 Retired, 2 Non-Operational, numeric codes **[Inferred]**):

```
statusTouched = changed(install_status) || changed(hardware_status) || changed(hardware_substatus)
opTouched     = changed(operational_status)
if isHardware(ci):                                    // keep the CI self-consistent first
  if hwPairChanged && !changed(install_status): install_status = installFromHw(pair)   // 6.5 then 6.4
  if changed(install_status) && !hwPairChanged:
    pair = (asset && mapAssetToInstall(asset) == install_status)
           ? mapAssetToHw(asset)                     // keep the linked asset's substate detail
           : hwFromInstall(install_status)           // 6.5 then 6.4
if statusTouched && !opTouched:
  if install_status == 7: operational_status = 6
  else if prev.install_status == 7: operational_status = 2
else if opTouched && !statusTouched:
  if operational_status == 6 && install_status != 7: install_status = 7; pair = (retired, '')
  else if prev.operational_status == 6 && operational_status != 6: install_status = 1; pair = (installed, in_use)
```
If the caller changes both groups in one write, the caller's values stand (only the hardware alignment runs).

### 6.7 Loop prevention and `skip_sync` **[Inferred]**
- Every write issued by the sync routines carries `ctx.sync = true`. After-rules that propagate (6.8) do nothing when `ctx.sync` is true, so one user write causes at most one write on the other side.
- `skip_sync = true` in an incoming insert or update suppresses propagation and auto-creation for that write only; the before-rule stores `skip_sync = false`.
- Only fields that actually differ are written; an unchanged target produces no update (no `sys_mod_count` increment, no audit).
- The CI coupling rule (6.6) runs on sync writes too (it is not a propagation rule), so an asset retirement retires the CI operationally.

### 6.8 Rule pseudocode (TypeScript sketch)

```ts
// after insert/update on alm_asset (and children)
function assetToCi(cur: Asset, prev: Asset | null, ctx: Ctx) {
  if (ctx.sync || cur.skipSyncRequested || isConsumableOrLicense(cur)) return;
  if (prev?.ci && prev.ci !== cur.ci) clearRef('cmdb_ci', prev.ci, 'asset', ctx);   // unlink old CI
  if (!cur.ci) { if (!prev) maybeCreateCi(cur, ctx); return; }
  const ci = load('cmdb_ci', cur.ci);
  const linking = !prev || prev.ci !== cur.ci;     // new link: this side wins, copy non-empty values
  const patch: Record<string, unknown> = linking ? { asset: cur.sys_id } : {};
  for (const [af, cf] of FIELD_SYNC)
    if (linking ? !isEmpty(cur[af]) : changed(cur, prev, af)) patch[cf] = cur[af];
  if (linking || changed(cur, prev, 'install_status') || changed(cur, prev, 'substatus')) {
    patch.install_status = mapAssetToInstall(cur.install_status, cur.substatus);
    if (isHardwareClass(ci)) Object.assign(patch, mapAssetToHw(cur.install_status, cur.substatus));
  }
  updateIfDifferent(ci, patch, { ...ctx, sync: true });   // CI before-rules (6.6) still run
}
// after insert/update on cmdb_ci (and descendants)
function ciToAsset(cur: Ci, prev: Ci | null, ctx: Ctx) {
  if (ctx.sync || cur.skipSyncRequested) return;
  if (prev?.asset && prev.asset !== cur.asset) clearRef('alm_asset', prev.asset, 'ci', ctx);
  if (!cur.asset) { if (!prev) maybeCreateAsset(cur, ctx); return; }
  const asset = load('alm_asset', cur.asset);
  const linking = !prev || prev.asset !== cur.asset;
  const patch: Record<string, unknown> = linking ? { ci: cur.sys_id } : {};
  for (const [af, cf] of FIELD_SYNC)
    if (linking ? !isEmpty(cur[cf]) : changed(cur, prev, cf)) patch[af] = cur[cf];
  if (linking || statusChanged(cur, prev)) {
    const target = hwPairChanged(cur, prev) && isHardwareClass(cur)
      ? mapHwToAsset(cur.hardware_status, cur.hardware_substatus) : mapInstallToAsset(cur.install_status);
    if (!alreadyEquivalent(asset, cur)) Object.assign(patch, target);   // no-op rule, 6.5
  }
  updateIfDifferent(asset, patch, { ...ctx, sync: true });
}
```

### 6.9 Deletion and reclassification **[Inferred]**
Deleting a CI clears `asset.ci` (asset kept); deleting an asset clears `cmdb_ci.asset` (CI kept); both reference columns use cascade `clear`. Reclassifying a CI keeps the link and does not change the asset class. When an asset becomes Retired the CI is retired, not deleted.

### 6.10 Optional CSDM life-cycle sync
Properties **[Documented]**: `csdm.lifecycle.migration.activated` enables life-cycle sync; `csdm.lifecycle.sync.between.ci.and.asset.activated` (default false) chooses between syncing through legacy status values (false) and syncing the CSDM pair directly (true). ResolvrNow v1 defaults both to false **[Inferred]**. When the first is true, the asset before-rule sets `life_cycle_stage/_status` from the 3.1/3.2 pair (no match gives `TBD`, **[Documented]** fallback), and the pair is copied to the CI through 6.3.

## 7. Contracts (`ast_contract`)

Sources: https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/foundation-domain.html, https://www.servicenow.com/docs/r/it-service-management/service-level-management/define-a-service-contract.html, https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/table-extension-and-classes.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/csdm-lifecycle-df-document.html

Documented: a contract is not a CI; it uses contract models; classes `ast_lease`, `ast_warranty` and `ast_service` (service contract, used by SLM to group SLAs, CIs, locations, groups, users and child contracts) extend `ast_contract`. SDK fields: `number` (prefix CNTR, start 10000), `short_description` (label Name), `vendor`, `vendor_contract`, `contract_model` (ref `cmdb_model`), `parent_contract`, `starts`, `ends`, `state` (default `draft`), `substate` (default `awaiting_review`, dependent on `state`), `active` (default true), `renewable` (default true), `renewal_date`, `renewal_end_date`, `notice_date`, `renewal_notice_period`, `termination_notice_days`, `approver`, `contract_administrator`, costs, `process_non_contractual_slas` (default true).

State and substate choices **[Inferred]** (only the two defaults are documented):

| `state` | `substate` values | CSDM document pair |
|---|---|---|
| `draft` | `awaiting_review` (default), `under_review`, `approved` | Ideation / Draft; Ideation / Under Evaluation (under_review, approved) |
| `active` | (none) | Operational / In Use; Operational / Renewed after an automatic renewal; Operational / Pending Retirement inside the notice window |
| `expired` | (none) | End of Life / Expired |
| `cancelled` | (none) | End of Life / Retired |

Contract to asset coverage: `clm_m2m_contract_asset` (`contract`, `asset`, `added` date, `removed` date, unique on contract+asset) **[Inferred]**. Optional rule: for an asset covered by active `ast_warranty` contracts, `warranty_expiration` = latest `ends` among them **[Inferred]**.

Daily job `Contract state management` (runs 00:05 UTC) **[Inferred]**:
1. `state=draft^substate=approved^starts<=today` → `state=active`, `substate=''`, `active=true`.
2. `state=active^notice_date<=today^expiration_notified=false` → fire `contract.expiration_notice`, set `expiration_notified=true` (ResolvrNow-internal column).
3. `state=active^ends<today`: if `renewable=true` and `renewal_end_date>=today` → `starts = renewal_date` (or `ends + 1 day` when empty), `ends = renewal_end_date`, clear `renewal_date`, `renewal_end_date`, `expiration_notified`, journal a renewal note, fire `contract.renewed`; else `state=expired`, `active=false`, fire `contract.expired`.
4. Manual actions: Submit for review (`awaiting_review` → `under_review`, `approver` mandatory), Approve (→ `approved`), Reject (→ `awaiting_review` with a work note), Cancel (any non-expired → `cancelled`, `active=false`).

## 8. Events, jobs and properties

| Kind | Name | Behaviour | Basis |
|---|---|---|---|
| Event | `sn_hamp.asset.deploy` | Sets the asset to State 1 In use (change Asset action Deploy) | D |
| Event | `sn_hamp.asset.retire` | If State is not 7: State 6 / `pending_disposal`; if already Retired: no change | D |
| Event | `asset.state.changed` | Fired after any State change; parm1 = old State, parm2 = new State | I |
| Event | `contract.expiration_notice`, `contract.expired`, `contract.renewed` | See 7 | I |
| Event | `stock_rule.threshold_reached` | See 5 | I |
| Job | Contract state management | Daily, see 7 | I |
| Job | Stock rule evaluation | Hourly, see 5 | I |
| Property | `resolvr.asset.auto_create_ci`, `resolvr.asset.auto_create_asset` | Booleans, default true | I |
| Property | `csdm.lifecycle.migration.activated`, `csdm.lifecycle.sync.between.ci.and.asset.activated` | Booleans, default false in ResolvrNow | D (names) |

## 9. Acceptance tests

Fixtures: category Computer (`alm_hardware`, `cmdb_ci_computer`), category Server (`alm_hardware`, `cmdb_ci_server`), model M1 (Computer), model Unknown, stockroom S1 at location L1, users U1 and U2. Status codes as in sections 3 and 6.

1. **Given** a REST insert of `alm_hardware` with model M1, State 6 and no stockroom, **When** submitted, **Then** it is rejected and no CI is created.
2. **Given** a REST insert with model M1, State 6, stockroom S1 and no Substate, **When** saved, **Then** `substatus=available`, `location=L1`, `quantity=1`, and `display_name = "<asset_tag> - <M1 display name>"`.
3. **Given** an asset 6/available, **When** a REST update sets `substatus=sold` without changing State, **Then** the update is rejected with a substate validity error.
4. **Given** an asset 6/available with `assigned_to` empty, **When** State is set to 1 and `assigned_to=U1`, **Then** `substatus` is empty, `stockroom` is empty, `install_date` and `assigned` equal now, `old_status=6`, `old_substatus=available`.
5. **Given** a new M1 asset inserted through REST with State 6/available and stockroom S1, **When** the insert completes, **Then** a `cmdb_ci_computer` exists with `asset` = the asset, `model_id=M1`, `install_status=6`, `hardware_status=in_stock`, `hardware_substatus=available`, and `asset.ci` = that CI.
6. **Given** an asset insert with `skip_sync=true`, **When** saved, **Then** no CI is created and the stored `skip_sync` is false.
7. **Given** model M2 with `asset_tracking_strategy=do_not_track` in category Computer, **When** a `cmdb_ci_computer` with `model_id=M2` is inserted, **Then** no asset is created.
8. **Given** no model on the CI, **When** a `cmdb_ci_server` with `install_status=1` is inserted, **Then** an `alm_hardware` asset is created with model Unknown, category Server, State 1, and the CI `model_id` is Unknown.
9. **Given** a CI class with no category (for example `cmdb_ci_service`), **When** a CI is inserted, **Then** no asset is created.
10. **Given** a linked pair in State 1, **When** the asset is set to 7/disposed, **Then** `retired=today`, `assigned_to` is empty, and the CI has `install_status=7`, `hardware_status=retired`, `hardware_substatus=disposed`, `operational_status=6`.
11. **Given** a linked pair in State 1 and CI `operational_status=1`, **When** a user sets CI `operational_status=6`, **Then** the CI has `install_status=7`, `hardware_status=retired`, and the asset is State 7 with empty Substate.
12. **Given** a retired linked pair, **When** a user sets the CI `install_status=6`, **Then** the CI `operational_status=2`, `hardware_status=in_stock`, `hardware_substatus=available`, and the asset is 6/available with `retired` cleared.
13. **Given** a retired linked pair, **When** a user sets CI `operational_status=1`, **Then** CI `install_status=1`, hardware pair `installed`/`in_use`, and the asset is State 1.
14. **Given** a linked pair, **When** the asset becomes 8/stolen, **Then** CI `install_status=8`; **When** it becomes 8/lost, **Then** CI `install_status=100`.
15. **Given** an asset in 6/defective linked to a computer CI whose `install_status` was set to 1 by an update with `skip_sync=true`, **When** a user sets the CI `install_status=6`, **Then** the CI hardware pair becomes `in_stock`/`defective`, and the asset is not written (still 6/defective, `sys_mod_count` unchanged).
16. **Given** a linked pair, **When** the asset `assigned_to` changes to U2, **Then** the CI `assigned_to=U2` and CI `assigned` equals the asset `assigned`.
17. **Given** a linked pair, **When** a user changes the CI `location`, **Then** the asset `location` equals the new value and the asset `sys_mod_count` grows by exactly 1; the CI is not written a second time.
18. **Given** a linked pair, **When** a CI update sets `location` and `skip_sync=true`, **Then** the asset location is unchanged and the stored CI `skip_sync` is false.
19. **Given** an asset in State 1, **When** event `sn_hamp.asset.retire` is processed, **Then** the asset is 6/pending_disposal; **Given** an asset already in State 7, **Then** it is unchanged.
20. **Given** an asset in 6/available, **When** event `sn_hamp.asset.deploy` is processed, **Then** the asset is in State 1 and its CI has `install_status=1`.
21. **Given** a model with two categories, **When** an asset of that model is inserted without `model_category`, **Then** the insert is rejected; with one category, the category is filled in.
22. **Given** an insert through the base table `alm_asset` with model M1, **When** saved, **Then** `sys_class_name=alm_hardware`.
23. **Given** a linked pair, **When** the CI is deleted, **Then** the asset remains and `asset.ci` is empty.
24. **Given** an asset 6 with Substate `reserved` and empty `reserved_for`, **When** saved through REST, **Then** it is rejected.
25. **Given** an `alm_consumable` insert in a category whose `cmdb_ci_class` is empty, **When** saved, **Then** no CI is created, and State 10 is accepted only on consumables.
26. **Given** a contract `draft/approved` with `starts=today`, **When** the daily job runs, **Then** `state=active`, `substate` empty, `active=true`.
27. **Given** an active contract with `ends=yesterday` and `renewable=false`, **When** the job runs, **Then** `state=expired`, `active=false`, and `contract.expired` is fired exactly once across two runs.
28. **Given** an active contract with `ends=yesterday`, `renewable=true`, `renewal_end_date` = today + 365 days, **When** the job runs, **Then** it stays active with `ends` = that date and `contract.renewed` is fired.
29. **Given** an active contract with `notice_date=today`, **When** the job runs twice, **Then** `contract.expiration_notice` is fired once.
30. **Given** an existing `clm_m2m_contract_asset` row for (C1, A1), **When** a second row for (C1, A1) is inserted, **Then** it is rejected.
31. **Given** `csdm.lifecycle.migration.activated=true`, **When** a linked asset is set to State 1, **Then** asset and CI both have life cycle stage Operational and status In Use.
