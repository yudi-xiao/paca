export const customFieldErrorCodes = {
  keyInvalid: "CUSTOM_FIELD_KEY_INVALID",
  keyTaken: "CUSTOM_FIELD_KEY_TAKEN",
  nameInvalid: "CUSTOM_FIELD_NAME_INVALID",
  notFound: "CUSTOM_FIELD_NOT_FOUND",
  optionsInvalid: "CUSTOM_FIELD_OPTIONS_INVALID",
  typeInvalid: "CUSTOM_FIELD_TYPE_INVALID",
} as const;

export type CustomFieldErrorCode =
  (typeof customFieldErrorCodes)[keyof typeof customFieldErrorCodes];

export class CustomFieldError extends Error {
  constructor(
    readonly code: CustomFieldErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "CustomFieldError";
  }
}

export const customFieldTypes = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "boolean",
  "url",
] as const;

export type CustomFieldType = (typeof customFieldTypes)[number];

export type CustomFieldDefinition = {
  id: string;
  projectId: string;
  fieldKey: string;
  displayName: string;
  fieldType: CustomFieldType;
  options: string[];
  isRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomFieldCreateInput = {
  fieldKey: string;
  displayName: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired?: boolean;
};

export type CustomFieldUpdateInput = {
  displayName?: string;
  options?: string[];
  isRequired?: boolean;
};

export type PersistedCustomFieldCreate = CustomFieldCreateInput & {
  id: string;
  projectId: string;
  fieldKey: string;
  displayName: string;
  options: string[];
  isRequired: boolean;
};

export interface CustomFieldRepository {
  list(projectId: string): Promise<CustomFieldDefinition[]>;
  findById(projectId: string, fieldId: string): Promise<CustomFieldDefinition>;
  create(input: PersistedCustomFieldCreate): Promise<CustomFieldDefinition>;
  update(
    projectId: string,
    fieldId: string,
    input: CustomFieldUpdateInput,
  ): Promise<CustomFieldDefinition>;
  delete(projectId: string, fieldId: string): Promise<void>;
}

const FIELD_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?$/;

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 100) {
    throw new CustomFieldError(customFieldErrorCodes.nameInvalid);
  }
  return name;
}

function normalizeKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!FIELD_KEY_PATTERN.test(key)) {
    throw new CustomFieldError(customFieldErrorCodes.keyInvalid);
  }
  return key;
}

function normalizeOptions(fieldType: CustomFieldType, value: string[] | undefined): string[] {
  const options = [...new Set((value ?? []).map((option) => option.trim()).filter(Boolean))];
  if (options.length > 100 || options.some((option) => option.length > 100)) {
    throw new CustomFieldError(customFieldErrorCodes.optionsInvalid);
  }
  if (fieldType !== "select" && fieldType !== "multi_select" && options.length > 0) {
    throw new CustomFieldError(customFieldErrorCodes.optionsInvalid);
  }
  return options;
}

export class CustomFieldService {
  constructor(private readonly repository: CustomFieldRepository) {}

  list(projectId: string): Promise<CustomFieldDefinition[]> {
    return this.repository.list(projectId);
  }

  get(projectId: string, fieldId: string): Promise<CustomFieldDefinition> {
    return this.repository.findById(projectId, fieldId);
  }

  create(projectId: string, input: CustomFieldCreateInput): Promise<CustomFieldDefinition> {
    if (!customFieldTypes.includes(input.fieldType)) {
      throw new CustomFieldError(customFieldErrorCodes.typeInvalid);
    }
    return this.repository.create({
      id: crypto.randomUUID(),
      projectId,
      fieldKey: normalizeKey(input.fieldKey),
      displayName: normalizeName(input.displayName),
      fieldType: input.fieldType,
      options: normalizeOptions(input.fieldType, input.options),
      isRequired: input.isRequired ?? false,
    });
  }

  async update(
    projectId: string,
    fieldId: string,
    input: CustomFieldUpdateInput,
  ): Promise<CustomFieldDefinition> {
    const current = await this.repository.findById(projectId, fieldId);
    const normalized: CustomFieldUpdateInput = {};
    if (input.displayName !== undefined) normalized.displayName = normalizeName(input.displayName);
    if (input.options !== undefined) {
      normalized.options = normalizeOptions(current.fieldType, input.options);
    }
    if (input.isRequired !== undefined) normalized.isRequired = input.isRequired;
    if (Object.keys(normalized).length === 0) return current;
    return this.repository.update(projectId, fieldId, normalized);
  }

  delete(projectId: string, fieldId: string): Promise<void> {
    return this.repository.delete(projectId, fieldId);
  }
}
