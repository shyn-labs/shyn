public struct RingBuffer<T>: Sendable where T: Sendable {
    private var items: [T] = []
    public let capacity: Int
    public init(capacity: Int) { self.capacity = capacity }
    public var count: Int { items.count }
    public mutating func append(_ item: T) {
        items.append(item)
        if items.count > capacity { items.removeFirst(items.count - capacity) }
    }
    public mutating func drain() -> [T] {
        defer { items.removeAll() }
        return items
    }
}
