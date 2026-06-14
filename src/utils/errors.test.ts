import { describe, it, expect } from 'vitest';
import { AppError, ErrorCodes, isAppError, toHttpErrorResponse } from './errors.js';

describe('AppError', () => {
  it('creates an error with statusCode, code, and message', () => {
    const err = new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('CONVERSATION_NOT_FOUND');
    expect(err.message).toBe('Conversation not found');
  });

  it('toJSON returns code and message', () => {
    const err = new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name');
    expect(err.toJSON()).toEqual({ code: 'MISSING_FIELD', message: 'Missing name' });
  });
});

describe('isAppError', () => {
  it('returns true for AppError instances', () => {
    expect(isAppError(new AppError(500, 'X', 'msg'))).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isAppError(new Error('regular'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });

  it('returns false for plain objects', () => {
    expect(isAppError({ statusCode: 500 })).toBe(false);
  });
});

describe('toHttpErrorResponse', () => {
  it('formats AppError correctly', () => {
    const err = new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Not found');
    expect(toHttpErrorResponse(err)).toEqual({
      error: { code: 'CONVERSATION_NOT_FOUND', message: 'Not found' },
    });
  });

  it('formats regular Error as INTERNAL_ERROR', () => {
    const err = new Error('something broke');
    expect(toHttpErrorResponse(err)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'something broke' },
    });
  });

  it('formats string errors as INTERNAL_ERROR', () => {
    expect(toHttpErrorResponse('crash')).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'crash' },
    });
  });

  it('formats unknown errors as INTERNAL_ERROR', () => {
    expect(toHttpErrorResponse(42)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: '42' },
    });
  });

  it('formats null as INTERNAL_ERROR', () => {
    expect(toHttpErrorResponse(null)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'null' },
    });
  });
});

describe('ErrorCodes', () => {
  it('defines all expected error codes', () => {
    expect(ErrorCodes.CONVERSATION_NOT_FOUND).toBe('CONVERSATION_NOT_FOUND');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCodes.MISSING_FIELD).toBe('MISSING_FIELD');
    expect(ErrorCodes.INVALID_SKILL_NAME).toBe('INVALID_SKILL_NAME');
    expect(ErrorCodes.INVALID_TEXT).toBe('INVALID_TEXT');
  });
});
