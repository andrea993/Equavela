//! Hash maps and sets with a fast hasher, for the analysis of every edit. Their keys are the
//! worksheet's own region ids and names, not untrusted input, so the DoS resistance of the standard
//! SipHash is not needed; it cost 7-11 % of each pass at 20 000 regions.

pub type HashMap<K, V> = std::collections::HashMap<K, V, foldhash::fast::RandomState>;
pub type HashSet<T> = std::collections::HashSet<T, foldhash::fast::RandomState>;
