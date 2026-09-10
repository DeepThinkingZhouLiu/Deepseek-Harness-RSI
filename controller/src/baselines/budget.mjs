import { ProtocolError } from '../protocol.mjs'

export class BaselineBudgetExhausted extends ProtocolError {
  constructor(message) {
    super(message)
    this.name = 'BaselineBudgetExhausted'
  }
}
