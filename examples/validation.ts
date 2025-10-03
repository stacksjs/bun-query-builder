// Minimal typed validator factory mimicking ts-validation's API shape
// This is only for typing demonstration in examples; no runtime validation.

export interface Validator<T> {
  name?: string
  validate: (value: T) => boolean
  test?: (value: T) => boolean
  getRules?: () => Array<{ test: (value: T) => boolean }>
  _values?: readonly any[]
}

function make<T>(name?: string): Validator<T> {
  const fn = ((): boolean => true) as (value: T) => boolean
  return { validate: fn, test: fn, getRules: () => [{ test: fn }], name }
}

function makeEnum<T extends string | number>(values: readonly T[]): Validator<T> {
  const fn = ((): boolean => true) as (value: T) => boolean
  return {
    validate: fn,
    test: fn,
    getRules: () => [{ test: fn }],
    name: 'enum',
    _values: values as any,
  }
}

export const v = {
  string: (): Validator<string> => make<string>('string'),
  text: (): Validator<string> => make<string>('text'),
  number: (): Validator<number> => make<number>('number'),
  bigint: (): Validator<bigint> => make<bigint>('bigint'),
  array: <T>(): Validator<T[]> => make<T[]>('array'),
  boolean: (): Validator<boolean> => make<boolean>('boolean'),
  enum: <T extends string | number>(values: readonly T[]): Validator<T> => makeEnum(values),
  date: (): Validator<Date> => make<Date>('date'),
  datetime: (): Validator<Date> => make<Date>('datetime'),
  object: <T extends Record<string, any>>(): Validator<T> => make<T>('object'),
  custom: <T>(_fn: (value: T) => boolean, _message: string): Validator<T> => make<T>('custom'),
  timestamp: (): Validator<number> => make<number>('timestamp'),
  timestampTz: (): Validator<number> => make<number>('timestampTz'),
  unix: (): Validator<number> => make<number>('unix'),
  password: (): Validator<string> => make<string>('password'),
  float: (): Validator<number> => make<number>('float'),
  double: (): Validator<number> => make<number>('double'),
  decimal: (): Validator<number> => make<number>('decimal'),
  time: (): Validator<string> => make<string>('time'),
  smallint: (): Validator<number> => make<number>('integer'),
  integer: (): Validator<number> => make<number>('integer'),
  json: (): Validator<unknown> => make<unknown>('json'),
  blob: (): Validator<Uint8Array> => make<Uint8Array>('blob'),
  binary: (): Validator<Uint8Array> => make<Uint8Array>('binary'),
}
