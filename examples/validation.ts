// Minimal typed validator factory mimicking ts-validation's API shape
// This is only for typing demonstration in examples; no runtime validation.

export interface Validator<T> {
  name?: string
  validate: (value: T) => boolean
  test?: (value: T) => boolean
  getRules?: () => Array<{ test: (value: T) => boolean }>
}

function make<T>(): Validator<T> {
  const fn = ((): boolean => true) as (value: T) => boolean
  return { validate: fn, test: fn, getRules: () => [{ test: fn }] }
}

function makeEnum<T extends string | number>(values: readonly T[]): Validator<T> {
  const fn = ((): boolean => true) as (value: T) => boolean
  return { 
    validate: fn, 
    test: fn, 
    getRules: () => [{ test: fn }],
    name: 'enum',
    _values: values as any
  }
}

export const v = {
  string: (): Validator<string> => make<string>(),
  text: (): Validator<string> => make<string>(),
  number: (): Validator<number> => make<number>(),
  bigint: (): Validator<bigint> => make<bigint>(),
  array: <T>(): Validator<T[]> => make<T[]>(),
  boolean: (): Validator<boolean> => make<boolean>(),
  enum: <T extends string | number>(values: readonly T[]): Validator<T> => makeEnum(values),
  date: (): Validator<Date> => make<Date>(),
  datetime: (): Validator<Date> => make<Date>(),
  object: <T extends Record<string, any>>(): Validator<T> => make<T>(),
  custom: <T>(_fn: (value: T) => boolean, _message: string): Validator<T> => make<T>(),
  timestamp: (): Validator<number> => make<number>(),
  timestampTz: (): Validator<number> => make<number>(),
  unix: (): Validator<number> => make<number>(),
  password: (): Validator<string> => make<string>(),
  float: (): Validator<number> => make<number>(),
  double: (): Validator<number> => make<number>(),
  decimal: (): Validator<number> => make<number>(),
  time: (): Validator<string> => make<string>(),
  smallint: (): Validator<number> => make<number>(),
  integer: (): Validator<number> => make<number>(),
  json: (): Validator<unknown> => make<unknown>(),
  blob: (): Validator<Uint8Array> => make<Uint8Array>(),
  binary: (): Validator<Uint8Array> => make<Uint8Array>(),
}
