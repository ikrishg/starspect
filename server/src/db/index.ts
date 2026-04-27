import { drizzle } from "drizzle-orm/d1"
import * as schema from './schema'

export type Drizzle = ReturnType<typeof drizzle<typeof schema>>
